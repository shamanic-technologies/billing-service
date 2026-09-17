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
 * A SPACED, FINITE RETRY SCHEDULE, and this is what stops the fix becoming a
 * worse bug than the deadlock. The coalescer's backoff CAPS at one hour —
 * exactly this sweep's interval — so an unguarded sweep would re-present a
 * refused card ~24 times a day forever, degrading it at its issuer, where
 * before this feature it was only re-presented when the customer was working.
 * The first correction (0042) stood an org down until `credited` moved, which
 * is right for a dead card and wrong for a customer who is momentarily short
 * and would pay on Thursday: it bought "never retry" and left the month-end
 * sweep as the only deterministic attempt. So: one charge immediately, then
 * +1d, +3d, +7d, +14d anchored on the streak's FIRST refusal, then stop.
 * `campaign_reload_sweep_attempts` (migrations 0042 + 0043) holds the anchor,
 * the rung and the notification marker. Two different things re-arm an org and
 * they must not be confused — a move in `credited` means the WORLD changed and
 * resets the streak; elapsed time means only that the next rung is due, so the
 * customer is not told again.
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
import { coalesceReload, type ReloadOutcome } from "./reload-coalescer.js";
import { sendEmail } from "./email-client.js";
import {
  isPermanentDecline,
  markCardUnusable,
  clearCardUnusable,
} from "./card-usability.js";
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
   * Blocked orgs whose card already refused and whose next scheduled retry is
   * not due yet.
   */
  awaitingRetry: number;
  /**
   * Blocked orgs that refused every rung of the retry schedule. The sweep is
   * done with them; the month-end sweep still settles what is owed.
   */
  exhausted: number;
  /**
   * Blocked orgs whose card the bank has called permanently unusable. Never
   * presented again by any sweep, at any interval — the card networks forbid
   * resubmitting those, and the customer has been told to replace the card.
   */
  cardUnusable: number;
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When to re-present a card after the FIRST refusal of a streak, measured from
 * that first refusal. One attempt immediately, then these; after the last one
 * the sweep stands down for good and the month-end sweep owns the debt.
 *
 * Why a schedule at all, and why this one. 0042 stood an org down until
 * `credited` moved, which is right for a dead card and wrong for the far more
 * common case — a customer momentarily short who would pay on Thursday. It
 * traded "re-present the card 24x a day forever" for "never retry", and the
 * only remaining deterministic attempt was monthly. Widening intervals over a
 * fortnight is what card-recovery practice converges on (Stripe's own Smart
 * Retries sit in the same shape): frequent enough to catch a topped-up account,
 * sparse enough not to degrade the card at its issuer, and FINITE, because a
 * card that has refused five times over two weeks is not going to say yes on
 * the sixth.
 */
const RETRY_SCHEDULE_MS = [1 * DAY_MS, 3 * DAY_MS, 7 * DAY_MS, 14 * DAY_MS] as const;

/** Total attempts in one streak: the immediate one plus every scheduled rung. */
export const MAX_ATTEMPTS_PER_STREAK = RETRY_SCHEDULE_MS.length + 1;

type StandDown = "not_due" | "exhausted" | "card_unusable";

interface AttemptDecision {
  /** Null when a charge should be attempted now. */
  standDown: StandDown | null;
  /** The rung this attempt would be, 1-based. */
  attemptCount: number;
  /** Anchor for the schedule — this streak's first refusal. */
  firstFailedAt: Date | null;
  /** When the customer was told about THIS streak, or null if never. */
  notifiedAt: Date | null;
}

/**
 * Should a card be presented for this org right now?
 *
 * Two things re-arm an org, and they are different questions. A move in
 * `credited` means the world changed — a paid top-up, a promo, a staff grant —
 * so the streak is over and everything resets. Elapsed time means only that the
 * next rung is due; the streak continues, and the customer is not told again.
 *
 * `credited` only ever RISES, so it needs no lifecycle of its own to answer the
 * first question, and the schedule is anchored on the streak's FIRST failure so
 * that a restart, a deploy or a missed tick cannot shift the next rung.
 */
async function decideAttempt(
  orgId: string,
  creditedCents: string,
  now: Date
): Promise<AttemptDecision> {
  const [row] = await db
    .select()
    .from(campaignReloadSweepAttempts)
    .where(eq(campaignReloadSweepAttempts.orgId, orgId))
    .limit(1);

  const fresh: AttemptDecision = {
    standDown: null,
    attemptCount: 1,
    firstFailedAt: null,
    notifiedAt: null,
  };

  // No history, a last attempt that WORKED, or a world that has changed since:
  // all three are a clean slate.
  if (!row) return fresh;
  if (row.lastOutcome === "succeeded") return fresh;
  if (cmpCents(row.creditedCentsAtAttempt, creditedCents) !== 0) return fresh;

  // The verdict is checked AFTER the credited comparison above, and that order
  // is the whole of it. Credited rising means money arrived — a hand payment, a
  // promo, a grant — so either the card was replaced or the debt is settled,
  // and a verdict about the OLD card is stale. Checking it first would be a
  // deadlock in miniature: nothing would ever charge again, so nothing could
  // ever succeed, so the mark could never be cleared. The same shape as the
  // pre-flight trap this whole module exists to undo.
  if (row.cardUnusableAt != null) {
    return {
      standDown: "card_unusable",
      attemptCount: row.attemptCount,
      firstFailedAt: row.firstFailedAt,
      notifiedAt: row.notifiedAt,
    };
  }

  const anchor = row.firstFailedAt ?? row.attemptedAt;
  const nextRung = RETRY_SCHEDULE_MS[row.attemptCount - 1];
  const decided = {
    attemptCount: row.attemptCount + 1,
    firstFailedAt: anchor,
    notifiedAt: row.notifiedAt,
  };

  // Past the last rung: five refusals over a fortnight is an answer. The
  // month-end sweep still settles what is owed.
  if (nextRung === undefined) return { ...decided, standDown: "exhausted" };
  if (now.getTime() < anchor.getTime() + nextRung) {
    return { ...decided, standDown: "not_due" };
  }
  return { ...decided, standDown: null };
}

/** Record the attempt, carrying the streak's anchor and rung forward. */
async function recordAttempt(
  orgId: string,
  creditedCents: string,
  outcome: "succeeded" | "failed",
  decision: AttemptDecision,
  justNotified: boolean,
  now: Date
): Promise<void> {
  // A succeeded attempt ends the streak, so its anchor and its notification
  // marker go with it — the next failure is a NEW streak and is told afresh.
  const values = {
    orgId,
    creditedCentsAtAttempt: creditedCents,
    lastOutcome: outcome,
    attemptCount: decision.attemptCount,
    firstFailedAt: outcome === "failed" ? decision.firstFailedAt ?? now : null,
    notifiedAt:
      outcome === "failed" ? (justNotified ? now : decision.notifiedAt) : null,
    // A permanent verdict is written by markCardUnusable alone, on a path that
    // never reaches here. So any mark still on the row belongs to a world that
    // has since moved on, and writing it away is what releases the org.
    cardUnusableAt: null,
    lastDeclineCode: null,
    attemptedAt: now,
  };
  await db
    .insert(campaignReloadSweepAttempts)
    .values(values)
    .onConflictDoUpdate({
      target: campaignReloadSweepAttempts.orgId,
      set: {
        creditedCentsAtAttempt: values.creditedCentsAtAttempt,
        lastOutcome: values.lastOutcome,
        attemptCount: values.attemptCount,
        cardUnusableAt: values.cardUnusableAt,
        lastDeclineCode: values.lastDeclineCode,
        firstFailedAt: values.firstFailedAt,
        notifiedAt: values.notifiedAt,
        attemptedAt: values.attemptedAt,
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
    awaitingRetry: 0,
    exhausted: 0,
    cardUnusable: 0,
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

      const decision = await decideAttempt(orgId, snapshot.creditedCents, now);
      // A permanent refusal outranks the schedule: no interval makes a stolen
      // card chargeable, and the networks forbid resubmitting it at all. It is
      // released by `credited` moving (handled inside decideAttempt), never by
      // time passing.
      if (decision.standDown === "card_unusable") {
        result.cardUnusable += 1;
        continue;
      }
      if (decision.standDown === "exhausted") {
        result.exhausted += 1;
        console.log(
          `[billing-service] campaign reload sweep: org ${orgId} refused ` +
            `${MAX_ATTEMPTS_PER_STREAK} times over the retry schedule at ` +
            `credited=${snapshot.creditedCents} — standing down, the month-end ` +
            `sweep owns what is owed`
        );
        continue;
      }
      if (decision.standDown === "not_due") {
        result.awaitingRetry += 1;
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

      const succeeded = outcome.status === "succeeded";
      const permanent =
        !succeeded && !outcome.backoffSkipped && isPermanentDecline(outcome.failure_code);

      if (permanent) {
        // The verdict replaces the streak: no rung, no "we will try again"
        // mail, and the record carries the reason it was based on.
        result.cardUnusable += 1;
        result.failed += 1;
        console.warn(
          `[billing-service] campaign reload sweep: org ${orgId} refused ` +
            `permanently (${outcome.failure_code}) — ${outcome.failure_reason ?? ""}`
        );
        await markCardUnusable({
          orgId,
          declineCode: outcome.failure_code as string,
          creditedCents: snapshot.creditedCents,
          recipientEmail: snapshot.customer.email,
          now,
        });
        continue;
      }

      // Tell the customer ONCE per streak, and never on a backoff-skipped
      // outcome (no charge was attempted, so nothing new was learned). The
      // marker is a COLUMN rather than lib/reload-coalescer's in-memory
      // counter, because that counter resets on every deploy and we deploy
      // several times a day — "once per streak" silently meant "once per
      // deploy". It is also why the email is decided BEFORE the row is written.
      const shouldNotify =
        !succeeded && !outcome.backoffSkipped && decision.notifiedAt == null;
      if (shouldNotify) {
        await notifyReloadFailed(orgId, snapshot.customer.email);
      }

      await recordAttempt(
        orgId,
        snapshot.creditedCents,
        succeeded ? "succeeded" : "failed",
        decision,
        shouldNotify,
        now
      );

      if (succeeded) {
        // A charge that went through voids anything we concluded about the card
        // (the customer may have replaced it).
        await clearCardUnusable(orgId);
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
          `${orgId} (attempt ${decision.attemptCount}/${MAX_ATTEMPTS_PER_STREAK}): ` +
          `${outcome.failure_reason ?? ""}`
      );
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
