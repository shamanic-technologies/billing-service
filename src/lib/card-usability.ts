/**
 * "Can this card ever be charged again?" — the one question our retry loops
 * never asked.
 *
 * Card-network rules split a refusal in two, and the split is not advisory.
 *
 *   TEMPORARY  insufficient funds, a processing error, an issuer that was
 *              unreachable, a plain "no" with no reason given. Retryable, and
 *              capped: Visa allows at most 15 reattempts per 30 days on a
 *              declined transaction and charges $0.10 for each one beyond.
 *   PERMANENT  lost, stolen, pickup, account closed or never existed, the
 *              customer revoked the recurring authorization. These may NEVER be
 *              resubmitted, at any interval.
 *
 * Our month-end sweep retries forever by design, and read no decline reason at
 * all — so a stolen card was re-presented every month for the life of the
 * account. Useless, and against the rules. This module is the reason both
 * sweeps now stop.
 *
 * CLASSIFY CONSERVATIVELY, and note which way "conservative" points here: an
 * unknown code is treated as TEMPORARY and keeps being retried. Getting it
 * wrong in that direction costs a few attempts inside a 15-per-30-day budget we
 * use about six of; getting it wrong the other way abandons a debt the customer
 * genuinely owes and leaves their campaigns dead with no automatic way back.
 * So only codes whose meaning is unambiguous appear below.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaignReloadSweepAttempts } from "../db/schema.js";
import { cmpCents } from "./cents.js";
import { sendEmail } from "./email-client.js";
import { createPlatformRun, completePlatformRun } from "./runs-client.js";

/**
 * The card is gone, dead, or we are no longer allowed to charge it. Every entry
 * is a definitive statement by the issuer about the instrument itself, not
 * about this particular attempt.
 */
const PERMANENT_DECLINE_CODES = new Set([
  // The instrument itself is gone or was never real.
  "lost_card",
  "stolen_card",
  "pickup_card",
  "invalid_account",
  "no_account",
  "closed_account",
  // We are no longer permitted to charge it off-session.
  "revocation_of_authorization",
  "revocation_of_all_authorizations",
  "stop_payment_order",
  // The issuer will not accept this kind of charge on this card, ever.
  "restricted_card",
  "transaction_not_allowed",
  "card_not_supported",
]);

/**
 * Is this refusal about the CARD (permanent) rather than about this attempt?
 *
 * Case- and whitespace-insensitive because the value crosses a service boundary
 * as free text. An absent or unrecognised code is NOT permanent — see the
 * conservatism note above.
 */
export function isPermanentDecline(code: string | null | undefined): boolean {
  if (!code) return false;
  return PERMANENT_DECLINE_CODES.has(code.trim().toLowerCase());
}

/**
 * "Your card cannot be charged again, replace it."
 *
 * Deliberately NOT `credit-debt-card-required`, which says we no longer have a
 * card on file. Here we DO have one — it is attached, it is just dead — and a
 * customer told "add a card" when they can see a card in their settings will
 * reasonably conclude the message is wrong and ignore it.
 */
export const CARD_UNUSABLE_EVENT = "credit-card-unusable";

/**
 * The platform is the actor: there is no end user behind a scheduler tick. Same
 * sentinel this service already uses for a write it performs itself; the
 * recipient is passed explicitly, so nothing downstream resolves a user from it.
 */
const PLATFORM_USER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Has this org's card been judged permanently unusable — and is that judgement
 * still current?
 *
 * The verdict is RELEASED by `credited` moving, and never by time passing.
 * Credited rising means money arrived (a hand payment, a promo, a staff grant),
 * so either the card was replaced or the debt is settled, and a verdict about
 * the old card is stale. Releasing it on TIME instead would put a stolen card
 * back in front of the network, which is the one thing the rules forbid.
 *
 * Checking it without that release would be a deadlock in miniature: nothing
 * would ever charge again, so nothing could ever succeed, so the mark could
 * never be cleared — the same shape as the pre-flight trap this whole feature
 * exists to undo. So this CLEARS as a side effect when it sees the world has
 * moved on, which is why it takes the current credited total.
 */
export async function isCardUnusableFor(
  orgId: string,
  creditedCents: string
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(campaignReloadSweepAttempts)
    .where(eq(campaignReloadSweepAttempts.orgId, orgId))
    .limit(1);
  if (!row || row.cardUnusableAt == null) return false;
  if (cmpCents(row.creditedCentsAtAttempt, creditedCents) !== 0) {
    await clearCardUnusable(orgId);
    return false;
  }
  return true;
}

/**
 * Record the verdict and tell the customer once.
 *
 * Returns whether THIS call was the one that marked it, so a caller can keep
 * its own counters honest. Idempotent: an org already marked is not re-marked
 * and not re-mailed, because the row is only cleared by a successful charge.
 */
export async function markCardUnusable(params: {
  orgId: string;
  declineCode: string;
  creditedCents: string;
  recipientEmail?: string | null;
  now?: Date;
}): Promise<{ marked: boolean }> {
  const now = params.now ?? new Date();

  // Claim it with a conditional UPDATE so two racing sweeps produce one mail.
  const claimed = await db
    .update(campaignReloadSweepAttempts)
    .set({ cardUnusableAt: now, lastDeclineCode: params.declineCode })
    .where(eq(campaignReloadSweepAttempts.orgId, params.orgId))
    .returning({ orgId: campaignReloadSweepAttempts.orgId });

  if (claimed.length === 0) {
    // No row yet — the very first attempt for this org was also a permanent
    // refusal. Write one so the verdict survives, and treat it as claimed.
    await db.insert(campaignReloadSweepAttempts).values({
      orgId: params.orgId,
      creditedCentsAtAttempt: params.creditedCents,
      lastOutcome: "failed",
      attemptCount: 1,
      firstFailedAt: now,
      notifiedAt: now,
      lastDeclineCode: params.declineCode,
      cardUnusableAt: now,
      attemptedAt: now,
    });
  }

  console.warn(
    `[billing-service] card marked permanently unusable for org ${params.orgId} ` +
      `(decline_code=${params.declineCode}) — no sweep will present it again ` +
      `until a charge succeeds`
  );

  // Fail-soft, like every notification on a money path: a mail that cannot be
  // sent must never undo a verdict that is already recorded.
  try {
    // The send needs a run that ALREADY EXISTS in runs-service — it records the
    // mail as a CHILD of the id we pass, so a minted uuid is answered 200 with
    // `sent: false` and the mail is silently dropped.
    const runId = await createPlatformRun("card-unusable-notify");
    if (runId) {
      sendEmail({
        eventType: CARD_UNUSABLE_EVENT,
        orgId: params.orgId,
        userId: PLATFORM_USER_ID,
        runId,
        recipientEmail: params.recipientEmail ?? undefined,
        metadata: {},
      });
      await completePlatformRun(runId);
    }
  } catch (err) {
    console.error(
      `[billing-service] card-unusable notification failed for org ${params.orgId}:`,
      err
    );
  }

  return { marked: true };
}

/** A charge went through, so whatever we concluded about the card is void. */
export async function clearCardUnusable(orgId: string): Promise<void> {
  await db
    .update(campaignReloadSweepAttempts)
    .set({ cardUnusableAt: null, lastDeclineCode: null })
    .where(eq(campaignReloadSweepAttempts.orgId, orgId));
}
