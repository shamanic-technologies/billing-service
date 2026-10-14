/**
 * AUTO-UPGRADE when a subscriber's credit runs out (owner 2026-10-11, migration 0081).
 *
 * Owner, verbatim (the consent the customer ticks): « Pour continuer à bénéficier du
 * service, j'accepte qu'en cas de crédits épuisés mon compte soit upgradé
 * automatiquement au plan supérieur, selon nos terms & conditions. »
 *
 * Worked example (owner-confirmed): $99/month plan, 3-day trial, $99 trial credit.
 * Campaigns spend ~$75/day, the credit is empty on day ~1.5 → we charge $100 NOW,
 * +$100 credit, the plan is now $199/month. Day 3, trial ends → $199 charged (the
 * first paid month, at the new plan). Total charged over 3 days: $299. The upgrade
 * during the trial does NOT wait for the trial end.
 *
 *  - One STEP = +SUBSCRIPTION_STEP_CENTS ($100) on the monthly amount, and the step
 *    is what is charged now. The period does NOT restart (unlike "upgrade now"): the
 *    next renewal simply charges the new amount.
 *  - The charge is an ordinary succeeded payment, so `credited` counts it (stripe-
 *    service's totals). It is NEVER the trial repayment: that is the first
 *    `subscription_charges` row of the plan, and a step lives in its own table.
 *  - Only for a plan with `auto_upgrade` (every plan created after 0081; the plans
 *    that existed before keep today's behaviour). No customer toggle: the only exit
 *    is cancelling. Only trialing / active, not paused, no cancel pending, and only
 *    while at least one campaign is ongoing (nothing running = nothing to keep
 *    running, never charged for).
 *  - Exactly once: a `pending` row is CLAIMED before the charge (partial unique
 *    index, one in flight per plan), and the "still blocked?" verdict is re-read
 *    AFTER the claim, so two racing triggers cannot both charge. Idempotency key =
 *    (plan, period, from-amount): a retried attempt collapses onto the same acquirer
 *    charge, and once paid the from-amount moves.
 *  - A REFUSED step stops auto-upgrading for the rest of that period: sending stops
 *    at zero as before and the out-of-credits email tells the customer. The next
 *    period re-arms it. A charge that never reached an acquirer (outage, timeout)
 *    stays `pending`; after STALE_PENDING_MS it is re-issued with the SAME key
 *    (the acquirer answers the first attempt's result), from any trigger and from
 *    the 5-minute watcher.
 */
import { and, eq, lt, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  subscriptionAutoUpgrades,
  subscriptions,
  type Subscription,
  type SubscriptionAutoUpgrade,
} from "../db/schema.js";
import { computeBalance } from "./balance.js";
import { resolveSpendBlock } from "./spend-block.js";
import { reloadOffSession } from "./reload.js";
import { fetchRecurringCampaignStatuses } from "./campaign-service-client.js";
import { notifyOwnerBillingEvent, usd } from "./owner-alerts.js";
import { SUBSCRIPTION_STEP_CENTS } from "./subscription.js";

/** The charge reason (lib/payment-alerts labels it "Subscription charge"). */
export const AUTO_UPGRADE_CHARGE_REASON = "subscription_auto_upgrade";
/** A claim older than this with no answer is re-issued with the same key. */
export const STALE_PENDING_MS = 5 * 60 * 1000;
const CHARGE_TIMEOUT_MS = 30_000;

export type AutoUpgradeResult =
  | { result: "upgraded"; subscription: Subscription; chargedCents: number; fromAmountCents: number; toAmountCents: number }
  | { result: "not_eligible"; reason: "grandfathered" | "not_live" | "sending_stopped" | "nothing_running" }
  | { result: "declined"; failureCode: string }
  /** The org's monthly charge limit refused the step (lib/monthly-charge-limit): nothing charged, no claim kept. */
  | { result: "limit_reached" }
  | { result: "declined_this_period" }
  | { result: "in_flight" }
  | { result: "no_longer_blocked" }
  | { result: "unavailable" };

/** Why this plan may not auto-upgrade, or null when it may. */
function ineligibility(sub: Subscription): "grandfathered" | "not_live" | "sending_stopped" | null {
  if (!sub.autoUpgrade) return "grandfathered";
  if (sub.status !== "trialing" && sub.status !== "active") return "not_live";
  if (sub.pausedAt || sub.cancelAtPeriodEnd) return "sending_stopped";
  return null;
}

export function autoUpgradeIdempotencyKey(row: Pick<SubscriptionAutoUpgrade, "subscriptionId" | "periodStart" | "fromAmountCents">): string {
  return `subscription-upgrade:${row.subscriptionId}:${row.periodStart.toISOString()}:${row.fromAmountCents}`;
}

function upstreamStatus(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/stripe-service .* failed: (\d{3})/);
  return m ? Number(m[1]) : null;
}

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`auto-upgrade charge timeout after ${ms}ms`)), ms);
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

async function hasOngoingCampaign(orgId: string): Promise<boolean | null> {
  const answer = await fetchRecurringCampaignStatuses(orgId);
  if (!answer.ok) return null;
  return answer.campaigns.some((c) => c.status === "ongoing");
}

/**
 * Charge a claimed step and apply what the acquirer answered. A claim we could not
 * get an answer for stays `pending` (re-issued later with the same key).
 */
async function chargeClaimed(
  row: SubscriptionAutoUpgrade,
  now: Date,
  reissue = false
): Promise<AutoUpgradeResult> {
  let failureCode: string;
  let reference: string | null = null;
  try {
    const outcome = await withTimeout(
      CHARGE_TIMEOUT_MS,
      reloadOffSession(
        row.orgId,
        row.chargedCents,
        autoUpgradeIdempotencyKey(row),
        {
          reason: AUTO_UPGRADE_CHARGE_REASON,
          subscription_id: row.subscriptionId,
          from_amount_cents: String(row.fromAmountCents),
          to_amount_cents: String(row.toAmountCents),
        },
        // A re-issue replays a charge the limit already allowed at its claim; its
        // money may already be in this month's total, so it must not be re-judged.
        { skipMonthlyLimit: reissue }
      )
    );
    if (outcome.limitReached) {
      // Never sent to an acquirer: drop the claim so a raised limit (or next
      // month) can step again. The limit email tells the customer.
      await db.delete(subscriptionAutoUpgrades).where(eq(subscriptionAutoUpgrades.id, row.id));
      return { result: "limit_reached" };
    }
    if (outcome.status === "succeeded") {
      const subscription = await db.transaction(async (tx) => {
        await tx
          .update(subscriptionAutoUpgrades)
          .set({ status: "paid", reference: outcome.reference ?? null, settledAt: now })
          .where(eq(subscriptionAutoUpgrades.id, row.id));
        const [updated] = await tx
          .update(subscriptions)
          .set({
            monthlyAmountCents: rawSql`${subscriptions.monthlyAmountCents} + ${row.toAmountCents - row.fromAmountCents}`,
            updatedAt: now,
          })
          .where(eq(subscriptions.id, row.subscriptionId))
          .returning();
        return updated;
      });
      console.log(
        `[billing-service] subscription auto-upgrade: org ${row.orgId} plan ${row.subscriptionId} ` +
          `${row.fromAmountCents} -> ${row.toAmountCents} cents/month, ${row.chargedCents} charged now`
      );
      notifyOwnerBillingEvent({
        orgId: row.orgId,
        emoji: "⬆️",
        text: `Subscription auto-upgraded (credit ran out): ${usd(row.fromAmountCents)} → ${usd(row.toAmountCents)}/month, ${usd(row.chargedCents)} charged now`,
        dedupKey: `sub-auto-upgrade:${row.id}`,
      });
      return {
        result: "upgraded",
        subscription,
        chargedCents: row.chargedCents,
        fromAmountCents: row.fromAmountCents,
        toAmountCents: row.toAmountCents,
      };
    }
    failureCode = outcome.failure_code ?? "declined";
    reference = outcome.reference ?? null;
  } catch (err) {
    const status = upstreamStatus(err);
    if (status !== 402 && status !== 404 && status !== 409) {
      console.error(
        `[billing-service] subscription auto-upgrade charge for org ${row.orgId} could not be attempted (kept pending, re-issued with the same key):`,
        err
      );
      return { result: "unavailable" };
    }
    failureCode = `http_${status}`;
  }
  await db
    .update(subscriptionAutoUpgrades)
    .set({ status: "declined", failureCode, reference, settledAt: now })
    .where(eq(subscriptionAutoUpgrades.id, row.id));
  console.warn(
    `[billing-service] subscription auto-upgrade REFUSED for org ${row.orgId} (${failureCode}): no retry this period, sending stops at zero`
  );
  return { result: "declined", failureCode };
}

async function pendingFor(subscriptionId: string): Promise<SubscriptionAutoUpgrade | null> {
  const [row] = await db
    .select()
    .from(subscriptionAutoUpgrades)
    .where(and(eq(subscriptionAutoUpgrades.subscriptionId, subscriptionId), eq(subscriptionAutoUpgrades.status, "pending")))
    .limit(1);
  return row ?? null;
}

/**
 * The org's credit ran out (lib/spend-block's verdict, checked by the caller): move
 * its plan up one step and charge the step now. Throws only on a database failure.
 */
export async function tryAutoUpgrade(sub: Subscription, now: Date = new Date()): Promise<AutoUpgradeResult> {
  const why = ineligibility(sub);
  if (why) return { result: "not_eligible", reason: why };

  const pending = await pendingFor(sub.id);
  if (pending) {
    if (now.getTime() - pending.createdAt.getTime() < STALE_PENDING_MS) return { result: "in_flight" };
    return chargeClaimed(pending, now, true);
  }

  const [refused] = await db
    .select({ id: subscriptionAutoUpgrades.id })
    .from(subscriptionAutoUpgrades)
    .where(
      and(
        eq(subscriptionAutoUpgrades.subscriptionId, sub.id),
        eq(subscriptionAutoUpgrades.periodStart, sub.currentPeriodStart),
        eq(subscriptionAutoUpgrades.status, "declined")
      )
    )
    .limit(1);
  if (refused) return { result: "declined_this_period" };

  const running = await hasOngoingCampaign(sub.orgId);
  if (running === null) return { result: "unavailable" };
  if (!running) return { result: "not_eligible", reason: "nothing_running" };

  let claimed: SubscriptionAutoUpgrade;
  try {
    [claimed] = await db
      .insert(subscriptionAutoUpgrades)
      .values({
        subscriptionId: sub.id,
        orgId: sub.orgId,
        periodStart: sub.currentPeriodStart,
        fromAmountCents: sub.monthlyAmountCents,
        toAmountCents: sub.monthlyAmountCents + SUBSCRIPTION_STEP_CENTS,
        chargedCents: SUBSCRIPTION_STEP_CENTS,
        status: "pending",
        createdAt: now,
      })
      .returning();
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { result: "in_flight" };
    throw err;
  }

  // Re-read the verdict under the claim: a step paid by a racing trigger just
  // before this claim has already refilled the credit.
  const [fresh] = await db.select().from(subscriptions).where(eq(subscriptions.id, sub.id)).limit(1);
  const stillBlocked = (await resolveSpendBlock(sub.orgId, await computeBalance(sub.orgId))).blocked;
  if (!fresh || fresh.monthlyAmountCents !== sub.monthlyAmountCents || !stillBlocked) {
    await db.delete(subscriptionAutoUpgrades).where(eq(subscriptionAutoUpgrades.id, claimed.id));
    return { result: "no_longer_blocked" };
  }
  return chargeClaimed(claimed, now);
}

/** Watcher: re-issue every claim left without an answer (same key, same charge). */
export async function resumeStaleAutoUpgrades(now: Date = new Date()): Promise<number> {
  const stale = await db
    .select()
    .from(subscriptionAutoUpgrades)
    .where(
      and(
        eq(subscriptionAutoUpgrades.status, "pending"),
        lt(subscriptionAutoUpgrades.createdAt, new Date(now.getTime() - STALE_PENDING_MS))
      )
    );
  let settled = 0;
  for (const row of stale) {
    try {
      if ((await chargeClaimed(row, now, true)).result !== "unavailable") settled += 1;
    } catch (err) {
      console.error(`[billing-service] stale auto-upgrade ${row.id} for org ${row.orgId} failed:`, err);
    }
  }
  return settled;
}
