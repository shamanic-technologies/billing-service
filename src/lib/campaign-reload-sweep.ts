/**
 * Blocked-campaign reload sweep — the reload `authorize` would have fired, for
 * a campaign that can never reach `authorize`.
 *
 * THE TRAP. Two rules that are individually correct compose into a state a
 * paying org cannot leave on its own:
 *
 *   - `GET /internal/campaigns/:id/affordability` (read-only pre-flight) refuses
 *     a run when `balance − lastRequired < floor`. campaign-service then does
 *     not dispatch.
 *   - the reload fires inside `POST /v1/customer_balance/authorize`, which the
 *     workflow only reaches once campaign-service HAS dispatched.
 *
 * So the recovery path sits BEHIND the gate that blocks it. An org whose balance
 * lands in the band `[floor, floor + lastRequired)` is refused every poll, and
 * every refusal is the very condition that should have charged its card. Nothing
 * errors, nothing is logged as a failure, and the campaign is simply silent.
 *
 * Measured in prod 2026-09-17, org 81b34252-…: balance −4994.13 cents against a
 * −5000 floor and a stored 11.80-cent estimate — 5.87 cents of headroom for a
 * run needing 11.80. Refused every ~30 minutes for 30 hours, 48 consecutive
 * `gate-check-result` BLOCKED events, while that org had paid us $195.15 across
 * 5 succeeded payments with zero failures, held a valid card, and its own
 * authorize route answered `sufficient: true`. The only escapes were incidental
 * non-campaign usage nudging the balance past the floor, or the month-end sweep
 * — i.e. up to ~30 days, which is not a bound worth having.
 *
 * WHAT THIS IS NOT. It is not a new money policy and not a second reload rule.
 * The condition and the charge are byte-for-byte what `authorize` computes
 * (`resolvePostpaidTier` → `balance − required < threshold` → reload up to
 * `threshold + required` in whole tier multiples). The only difference is WHO
 * asks: here the hourly scheduler asks on behalf of a campaign that is not
 * allowed to. The read-only pre-flight is deliberately left untouched — giving
 * it side effects would make a GET charge cards, and relaxing its verdict would
 * re-open the paid-enrichment retry storm it exists to stop.
 *
 * ATTEMPT ONCE PER CREDITED LEVEL. The first charge answers the only question
 * this sweep can ask — is the org blocked by US or by its own card — and a
 * refusal answers "the card", which the dunning engine already owns. The
 * coalescer's backoff CAPS at one hour, exactly this sweep's interval, so
 * without a durable marker a dead card would be re-presented ~24 times a day
 * forever, degrading it at its issuer for no chance of a different answer.
 * `campaign_reload_sweep_attempts` (migration 0042) records the CREDITED total
 * at the attempt; credited only ever rises, so any recharge re-arms the sweep
 * and a dead card does not.
 *
 * An org that CANNOT be reloaded (no auto-topup config, no chargeable card, or a
 * blocked issuing country) is counted and logged, never charged and never mailed
 * by this module: those orgs are already owned by the depletion-episode dunning
 * engine, and a second notification mechanism for one state is how a customer
 * gets told twice. Verified 2026-09-17: all five such orgs blocked at the time
 * already carried an OPEN episode with its T0 sent.
 */

import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaignReloadSweepAttempts } from "../db/schema.js";
import crypto from "crypto";
import { computeBalance } from "./balance.js";
import { resolvePostpaidTier, computeTopupCharge } from "./topup-tier.js";
import { addCents, subCents, cmpCents, gte as gteCents } from "./cents.js";
import { reloadOffSession } from "./reload.js";
import {
  coalesceReload,
  consecutiveReloadFailures,
  type ReloadOutcome,
} from "./reload-coalescer.js";
import { sendEmail } from "./email-client.js";
import { createPlatformRun, completePlatformRun } from "./runs-client.js";

const RELOAD_TIMEOUT_MS = 30_000;

/**
 * The platform is the actor on this charge — there is no end user behind a
 * scheduler tick. Same documented sentinel the month-end sweep and the promo
 * grants use for a WRITE this service genuinely performs; the recipient of the
 * failure mail is passed explicitly, so no user identity is ever resolved from
 * it.
 */
const PLATFORM_USER_ID = "00000000-0000-0000-0000-000000000000";

/** Hour bucket (UTC epoch hours) — the idempotency scope for one tick. */
function hourBucket(now: Date): number {
  return Math.floor(now.getTime() / 3_600_000);
}

/**
 * Idempotency key scoped to (org, hour, charge amount).
 *
 * The PRIMARY guard is the balance re-check: once the charge lands, the org
 * clears `balance − required >= floor` and the next tick skips it entirely. The
 * key only collapses a re-tick inside the same hour (a restart 60s after boot)
 * onto one charge. The AMOUNT is in the key for the reason the month-end sweep
 * documents at length — an acquirer rejects a replayed key whose parameters
 * changed, so an amount-independent key would make a legitimately different
 * charge impossible for the rest of the hour.
 */
export function campaignReloadIdempotencyKey(
  orgId: string,
  bucket: number,
  chargeAmountCents: number
): string {
  return crypto
    .createHash("sha256")
    .update(`campaign-reload-sweep:${orgId}:${bucket}:${chargeAmountCents}`)
    .digest("hex")
    .slice(0, 32);
}

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`campaign reload sweep timeout after ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export interface CampaignReloadSweepResult {
  /** Orgs holding at least one stored campaign estimate. */
  scanned: number;
  /** Orgs whose next run the pre-flight is currently refusing. */
  blocked: number;
  /** Blocked orgs charged one reload. */
  charged: number;
  /**
   * Blocked orgs with no credit line (no config / no card / blocked issuing
   * country). Counted and logged, never charged — the dunning engine owns them.
   */
  notReloadCapable: number;
  /** Blocked orgs whose reload errored, declined, or was refused by the backoff. */
  failed: number;
  /**
   * Blocked orgs already attempted at this exact credited total, whose card
   * refused. Not charged again until a recharge moves `credited` — see
   * "attempt once per credited level" below.
   */
  awaitingRecharge: number;
}

interface OrgEstimate {
  orgId: string;
  /** The largest stored estimate across this org's campaigns. */
  maxRequiredCents: string;
}

/**
 * Every org that has a stored campaign estimate, with the LARGEST of them.
 *
 * The largest is the right one: covering the hungriest campaign covers every
 * other campaign of the same org, and one reload serves them all — so an org is
 * never charged once per campaign.
 */
async function loadOrgEstimates(): Promise<OrgEstimate[]> {
  const rows = await db.execute<{ org_id: string; max_required: string }>(sql`
    SELECT org_id, MAX(last_authorize_required_cents) AS max_required
    FROM campaign_authorize_costs
    GROUP BY org_id
  `);
  return (rows as unknown as { org_id: string; max_required: string }[]).map((r) => ({
    orgId: r.org_id,
    maxRequiredCents: String(r.max_required),
  }));
}

/**
 * Has this org already been presented a card at this exact credited total, and
 * refused?
 *
 * ATTEMPT ONCE PER CREDITED LEVEL. The sweep exists to break a DEADLOCK, not to
 * collect a debt. Its first charge answers the only question it can ask: is the
 * org blocked by us (the pre-flight refusing a run authorize would have funded)
 * or by its own card? A refusal answers "the card", and that is a state the
 * depletion-episode dunning engine already owns — so charging again on the next
 * tick learns nothing, and the cost of asking is real: repeated declines degrade
 * the card at its issuer and our decline rate at the acquirer (the whole reason
 * lib/reload-coalescer's backoff exists). The coalescer's cooldown CAPS at one
 * hour, which is exactly this sweep's own interval, so without this the sweep
 * would re-present a dead card ~24 times a day forever.
 *
 * `credited` only ever RISES, so it needs no new lifecycle to say "something
 * changed": any recharge — a paid top-up, a promo, a staff grant — moves it and
 * re-arms the sweep, while a dead card moves nothing.
 */
async function alreadyAttemptedAtThisCredit(
  orgId: string,
  creditedCents: string
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(campaignReloadSweepAttempts)
    .where(eq(campaignReloadSweepAttempts.orgId, orgId))
    .limit(1);
  if (!row) return false;
  if (row.lastOutcome === "succeeded") return false;
  return cmpCents(row.creditedCentsAtAttempt, creditedCents) === 0;
}

/** Record that a card was presented for this org at this credited total. */
async function recordAttempt(
  orgId: string,
  creditedCents: string,
  outcome: "succeeded" | "failed"
): Promise<void> {
  await db
    .insert(campaignReloadSweepAttempts)
    .values({
      orgId,
      creditedCentsAtAttempt: creditedCents,
      lastOutcome: outcome,
      attemptedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: campaignReloadSweepAttempts.orgId,
      set: {
        creditedCentsAtAttempt: creditedCents,
        lastOutcome: outcome,
        attemptedAt: new Date(),
      },
    });
}

/** Tell the customer their card could not be charged — once per failure streak. */
async function notifyReloadFailed(
  orgId: string,
  recipientEmail: string | null | undefined
): Promise<void> {
  // A send with no end user behind it needs a run that ALREADY EXISTS in
  // runs-service: transactional-email-service records the mail as a CHILD of the
  // id we pass, so a minted uuid answers 200 with `sent: false` and the mail is
  // silently dropped. A run we cannot open means we do not send — the next tick
  // retries.
  const runId = await createPlatformRun("campaign-reload-sweep-notify");
  if (!runId) return;
  sendEmail({
    eventType: "credits-reload-failed",
    orgId,
    userId: PLATFORM_USER_ID,
    runId,
    recipientEmail: recipientEmail ?? undefined,
  });
  await completePlatformRun(runId);
}

/**
 * Charge every reload-capable org whose campaign the affordability pre-flight is
 * refusing. Per-org failure is logged and skipped — one unreachable org never
 * blocks the rest (same shape as runDunningTick / runMonthEndSweep).
 */
export async function runCampaignReloadSweep(
  now: Date = new Date()
): Promise<CampaignReloadSweepResult> {
  const result: CampaignReloadSweepResult = {
    scanned: 0,
    blocked: 0,
    charged: 0,
    notReloadCapable: 0,
    failed: 0,
    awaitingRecharge: 0,
  };

  const estimates = await loadOrgEstimates();
  const bucket = hourBucket(now);

  for (const { orgId, maxRequiredCents } of estimates) {
    result.scanned += 1;
    try {
      const [snapshot, account] = await Promise.all([
        computeBalance(orgId),
        db
          .execute<{ topup_amount_cents: number | null }>(sql`
            SELECT topup_amount_cents FROM billing_accounts WHERE org_id = ${orgId} LIMIT 1
          `)
          .then(
            (rows) =>
              (rows as unknown as { topup_amount_cents: number | null }[])[0] ?? null
          ),
      ]);

      const { tier, thresholdCents } = resolvePostpaidTier({
        topupEnabled: account?.topup_amount_cents != null,
        hasCardPm: snapshot.hasCardPm,
        autoReloadSupported: snapshot.autoReloadSupported,
        paidTopupsCents: snapshot.paidTopupsCents,
      });

      // The affordability verdict, restated verbatim. Not blocked → nothing due.
      if (gteCents(subCents(snapshot.balanceCents, maxRequiredCents), thresholdCents)) {
        continue;
      }
      result.blocked += 1;

      if (!tier) {
        result.notReloadCapable += 1;
        console.warn(
          `[billing-service] campaign reload sweep: org ${orgId} is blocked ` +
            `(balance=${snapshot.balanceCents} required=${maxRequiredCents} ` +
            `floor=${thresholdCents}) and has no credit line — owned by dunning, ` +
            `not charged here`
        );
        continue;
      }

      if (await alreadyAttemptedAtThisCredit(orgId, snapshot.creditedCents)) {
        result.awaitingRecharge += 1;
        console.log(
          `[billing-service] campaign reload sweep: org ${orgId} already had a ` +
            `card presented at credited=${snapshot.creditedCents} and it refused — ` +
            `not charging again until a recharge moves credited (dunning owns it)`
        );
        continue;
      }

      // Exactly what authorize charges: enough whole tier multiples to lift the
      // balance to (floor + required), so the run clears WITH the floor headroom
      // preserved.
      const targetCents = addCents(thresholdCents, maxRequiredCents);
      const chargeAmount = computeTopupCharge(
        snapshot.balanceCents,
        targetCents,
        tier.amountCents
      );
      if (chargeAmount <= 0) continue;

      const outcome = await coalesceReload(orgId, () =>
        withTimeout(
          RELOAD_TIMEOUT_MS,
          reloadOffSession(
            orgId,
            chargeAmount,
            campaignReloadIdempotencyKey(orgId, bucket, chargeAmount),
            { reason: "campaign_reload_sweep" }
          )
        )
      ).catch((err) => {
        // A DECLINED off_session charge arrives as a throw (stripe-service
        // answers 402). The coalescer has already armed its backoff on this
        // rejection; we turn it into a settled failure so the one reaction that
        // differs — telling the customer — is decided in one place below.
        console.error(
          `[billing-service] campaign reload sweep: reload threw for org ${orgId}:`,
          err
        );
        const synthetic: ReloadOutcome = { status: "failed", failure_reason: String(err) };
        return synthetic;
      });

      await recordAttempt(
        orgId,
        snapshot.creditedCents,
        outcome.status === "succeeded" ? "succeeded" : "failed"
      );

      if (outcome.status === "succeeded") {
        result.charged += 1;
        console.log(
          `[billing-service] campaign reload sweep: charged org ${orgId} ` +
            `${chargeAmount} cents to unblock a refused campaign ` +
            `(balance=${snapshot.balanceCents} required=${maxRequiredCents} ` +
            `floor=${thresholdCents})`
        );
        continue;
      }

      result.failed += 1;
      console.warn(
        `[billing-service] campaign reload sweep: reload ${outcome.status} for org ` +
          `${orgId}: ${outcome.failure_reason ?? ""}`
      );
      // Tell the customer on the FIRST failure of a streak only, and never on a
      // backoff-skipped outcome (no charge was attempted, nothing new was
      // learned). Same guard as the authorize path, and for the same reason: the
      // email is org-billed, so an unguarded send re-enters authorize and feeds
      // the failure it reports.
      if (!outcome.backoffSkipped && consecutiveReloadFailures(orgId) <= 1) {
        await notifyReloadFailed(orgId, snapshot.customer.email);
      }
    } catch (err) {
      result.failed += 1;
      console.error(
        `[billing-service] campaign reload sweep failed for org ${orgId}, skipping:`,
        err
      );
      continue;
    }
  }

  return result;
}
