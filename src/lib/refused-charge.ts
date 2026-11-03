/**
 * A refused card stops the org AT ONCE (INSTANT-STOP-ON-DECLINE-1103).
 *
 * Prod 2026-11-03, Beyond Logic (postpaid): a $50.02 reload was refused at
 * 14:57:04 (insufficient funds), from `usage_apply`. That refusal lived only in
 * the in-memory reload backoff (lib/reload-coalescer). Every "can this org be
 * charged?" reader (payment outlook, payment-stopped periods, revenue) reads the
 * DURABLE refusal streak (`campaign_reload_sweep_attempts`), which only the
 * hourly blocked-campaign sweep wrote: it ran at 15:27, the outlook flipped to
 * `charge_blocked / card_declined`, and campaign-service stopped the campaigns at
 * 15:30. 34 minutes of sends on a card the bank had already refused.
 *
 * So the refusal is now recorded where it HAPPENS: `chargeNow` (lib/reload, the
 * one charge path) calls `recordRefusedCharge` on every refused answer, before it
 * returns. Every path that charges (authorize, usage_apply, sweeps, month end,
 * card change, pay balance, on-demand, subscription) is covered with no code of
 * its own, and the next read sees the streak.
 *
 * It is the SAME streak the sweep walks, not a second state: the first refusal
 * opens it (rung 1, anchored now), a later refusal inside it changes nothing but
 * `attempted_at` (the rungs stay the sweep's, so the retry schedule is not
 * shifted), and `credited` moving ends it (a top-up, a paid balance, a grant),
 * exactly as `decideAttempt` decides.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, campaignReloadSweepAttempts } from "../db/schema.js";
import { cmpCents } from "./cents.js";
import { composeCreditedCents } from "./balance.js";
import { isPermanentDecline, markCardUnusable } from "./card-usability.js";

export type RefusalStreak = typeof campaignReloadSweepAttempts.$inferSelect;

/**
 * The org's open refused-card streak, or null.
 *
 * Open = the last attempt failed AND `credited` has not moved since. Credited
 * rising means money arrived, so the streak is over: the same test, in the same
 * order, as the sweep's `decideAttempt`, so no two readers disagree about
 * whether this org's card is currently refused.
 */
export async function openRefusalStreak(
  orgId: string,
  creditedCents: string
): Promise<RefusalStreak | null> {
  const [row] = await db
    .select()
    .from(campaignReloadSweepAttempts)
    .where(eq(campaignReloadSweepAttempts.orgId, orgId))
    .limit(1);
  if (!row) return null;
  if (row.lastOutcome !== "failed") return null;
  if (cmpCents(row.creditedCentsAtAttempt, creditedCents) !== 0) return null;
  return row;
}

/**
 * The refusal that STOPS this org's campaign spend right now, or null.
 *
 * Prepaid and postpaid alike (owner 2026-11-03: no more spend on a card we know
 * is refused). A SUBSCRIPTION org is excluded: its refused renewal has its own
 * lifecycle (past_due, rungs, end; lib/subscription) and its spend already stops
 * at zero credit.
 */
export async function refusalBlockingSpend(
  orgId: string,
  creditedCents: string
): Promise<RefusalStreak | null> {
  const [account] = await db
    .select({ paymentMode: billingAccounts.paymentMode })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  if (account?.paymentMode === "subscription") return null;
  return openRefusalStreak(orgId, creditedCents);
}

/**
 * Record that the bank just refused a charge for this org. Awaited by the charge
 * path, so the very next authorize / affordability / outlook read sees it.
 *
 * Fail-loud: a write that fails throws, and the caller treats the charge as
 * errored (no spend is authorized on it). Never swallowed: a refusal nobody
 * recorded is exactly the 34 minutes this exists to remove.
 */
export async function recordRefusedCharge(params: {
  orgId: string;
  declineCode: string | null;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const { creditedCents } = await composeCreditedCents(params.orgId);
  const open = await openRefusalStreak(params.orgId, creditedCents);

  if (open) {
    // Same streak: the sweep owns its rungs, so only the attempt instant moves.
    await db
      .update(campaignReloadSweepAttempts)
      .set({ attemptedAt: now })
      .where(eq(campaignReloadSweepAttempts.orgId, params.orgId));
  } else {
    const fresh = {
      creditedCentsAtAttempt: creditedCents,
      lastOutcome: "failed",
      attemptCount: 1,
      firstFailedAt: now,
      notifiedAt: null,
      cardUnusableAt: null,
      lastDeclineCode: null,
      attemptedAt: now,
    };
    await db
      .insert(campaignReloadSweepAttempts)
      .values({ orgId: params.orgId, ...fresh })
      .onConflictDoUpdate({ target: campaignReloadSweepAttempts.orgId, set: fresh });
    console.warn(
      `[billing-service] card refused for org ${params.orgId} ` +
        `(decline_code=${params.declineCode ?? "none"}): charging is blocked until money arrives`
    );
  }

  // A lost / stolen / closed card may never be presented again (lib/card-usability).
  if (isPermanentDecline(params.declineCode)) {
    await markCardUnusable({
      orgId: params.orgId,
      declineCode: params.declineCode!,
      creditedCents,
      now,
    });
  }
}
