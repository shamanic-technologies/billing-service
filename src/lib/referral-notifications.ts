/**
 * Telling the two people in a referral what they cannot see coming.
 *
 * The money already works end to end: a customer shares their link, someone signs
 * up through it and pays, that opens a $500 reward for the referrer, and the
 * referrer earns it on their own next payments. None of it produced any
 * notification, so a referrer had no reason to open the dashboard on the day any
 * of it happened. They could bring in three converting customers and never learn
 * the referral worked, let alone that money was waiting. An offer whose whole
 * mechanism is "keep paying and it lands" is worth nothing to someone who never
 * finds out it landed.
 *
 * ## Which moments, and which were dropped
 *
 * TWO messages, both about something the recipient could not otherwise know:
 *
 *   - `referral-reward-opened` → the REFERRER, when someone they invited converts
 *     and a reward opens. This is the one that cannot be inferred from anything
 *     they can see, and it is the one that makes sharing the link feel worth it.
 *   - `referral-credits-granted` → whoever just had a reward GRANTED, on either
 *     side, when the credits actually land.
 *
 * Both name the referral that caused them, because a referrer holding three
 * pending $500s cannot otherwise tell which one a message is about. That is the
 * same identity the Billing page already resolves, under the same authorization:
 * billing is the only service that knows the referral relationship exists.
 *
 * Deliberately NOT sent:
 *
 *   - the invitee's promise being CREATED at signup. Nothing has been earned, and
 *     the person is mid-onboarding being told the same thing on screen.
 *   - "opened" when the reward is ALREADY earned the moment it opens. A referrer
 *     whose own payments are past the new bar earns it on the very next settle, so
 *     "$500 is on its way" followed minutes later by "$500 arrived" teaches nothing
 *     with the second message. `alreadyEarned` collapses that pair down to the
 *     granted one, which names the same referral anyway.
 *   - a separate "your welcome credits landed". That is the other offer, and this
 *     module is not the place to start mailing about it.
 *
 * ## Exactly once
 *
 * The sweep re-examines every promise on every tick, so "we granted it" cannot
 * double as "we told them". Each message claims its own marker column with a
 * CONDITIONAL update that only matches while the marker is still NULL, and only
 * the caller whose update returns a row sends. Two racing settles therefore
 * produce one email, and a replayed payment produces none.
 *
 * ## Fail-soft, deliberately
 *
 * The documented exception to this repo's fail-loud rule, same posture as the
 * identity lookup this feature already relies on: the promise is the money-bearing
 * information and the mail is not. A recipient we cannot resolve, or a send that
 * throws, logs loudly and returns. It never fails, delays or rolls back a grant.
 */
import crypto from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { freeCreditPromises, type FreeCreditPromise } from "../db/schema.js";
import { sendEmail } from "./email-client.js";
import {
  fetchOrgCustomer,
  sumSucceededTopupsForOrg,
} from "./stripe-service-client.js";
import { resolveOrgDisplayIdentity } from "./brand-service-client.js";
import { gte } from "./cents.js";
import { Decimal } from "decimal.js";

/** Someone you invited converted, so a reward just opened for you. */
export const REFERRAL_REWARD_OPENED_EVENT = "referral-reward-opened";

/** A referral reward has actually been credited. */
export const REFERRAL_CREDITS_GRANTED_EVENT = "referral-credits-granted";

// Platform-issued, like every other system-originated row here. The recipient is
// resolved explicitly from the org's billing customer, so this identity is only
// ever the ACTOR, never the addressee.
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

function dollars(cents: number): string {
  return `$${new Decimal(cents).dividedBy(100).toFixed(0)}`;
}

/**
 * Claim the right to send, exactly once.
 *
 * Returns true only for the caller whose UPDATE actually matched, so a racing
 * settle or a re-running sweep silently declines instead of sending again.
 */
async function claimNotification(
  promiseId: string,
  column: "openedNotifiedAt" | "grantedNotifiedAt"
): Promise<boolean> {
  const marker =
    column === "openedNotifiedAt"
      ? freeCreditPromises.openedNotifiedAt
      : freeCreditPromises.grantedNotifiedAt;

  const claimed = await db
    .update(freeCreditPromises)
    .set({ [column]: new Date() })
    .where(and(eq(freeCreditPromises.id, promiseId), isNull(marker)))
    .returning({ id: freeCreditPromises.id });

  return claimed.length > 0;
}

/** The address to write to, or null when the org has no billing customer yet. */
async function recipientFor(orgId: string): Promise<string | null> {
  try {
    const customer = await fetchOrgCustomer(orgId);
    return customer.email ?? null;
  } catch (err) {
    console.error(
      `[billing-service] referral notification: no billing customer for org ${orgId}, skipping send`,
      err
    );
    return null;
  }
}

/**
 * Is this reward ALREADY earned the moment it opens?
 *
 * A referrer whose own payments are already past the new bar earns the reward on
 * the very next settle, so telling them "$500 is on its way" and then, minutes
 * later, "$500 arrived" teaches them nothing with the second message. When the bar
 * is already met we say nothing here and let the granted message carry the whole
 * story — it names the same referral.
 *
 * Fail-OPEN: a paid-topups read that throws yields false, so the referrer is told
 * their referral converted. A possible duplicate beats silence about money.
 */
async function alreadyEarned(promise: FreeCreditPromise): Promise<boolean> {
  try {
    const paid = await sumSucceededTopupsForOrg(promise.orgId);
    return gte(paid, new Decimal(promise.paidTriggerCents).toFixed(10));
  } catch (err) {
    console.error(
      `[billing-service] referral notification: could not read paid topups for org ${promise.orgId}, assuming the reward is not yet earned:`,
      err
    );
    return false;
  }
}

/**
 * Tell the REFERRER that someone they invited converted.
 *
 * Names who it was when we can resolve them, because a referrer with several
 * pending rewards otherwise cannot tell which one this is about. The name is the
 * same one the Billing page shows, and resolving it is fail-soft there too: an
 * unresolvable org simply yields a message that does not name anyone rather than
 * one naming a UUID.
 */
export async function notifyReferralRewardOpened(
  promise: FreeCreditPromise
): Promise<void> {
  try {
    // Deliberately unstamped when we skip: the promise is about to be granted,
    // which takes it out of every outstanding set for good, so there is nothing
    // left that could send this message late.
    if (await alreadyEarned(promise)) {
      console.log(
        `[billing-service] referral reward opened ALREADY EARNED org=${promise.orgId} ` +
          `promise=${promise.id} — the granted message will carry it`
      );
      return;
    }

    // Resolve the recipient BEFORE claiming. Claiming first would burn the
    // marker on a transient failure (a cold stripe-service, an org whose
    // customer is not created yet) and the notification would then never be
    // retried by any later sweep — silently losing it forever.
    const recipientEmail = await recipientFor(promise.orgId);
    if (!recipientEmail) return;

    if (!(await claimNotification(promise.id, "openedNotifiedAt"))) return;

    const identity = promise.referredOrgId
      ? await resolveOrgDisplayIdentity(promise.referredOrgId)
      : null;

    sendEmail({
      eventType: REFERRAL_REWARD_OPENED_EVENT,
      orgId: promise.orgId,
      userId: SYSTEM_USER_ID,
      runId: crypto.randomUUID(),
      recipientEmail,
      metadata: {
        amount: dollars(promise.amountCents),
        unlockAt: dollars(promise.paidTriggerCents),
        // Always a real phrase, never blank: the name sits mid-sentence, and an
        // empty substitution would leave a hole there. "A new customer" names
        // nobody, which is the honest rendering when the lookup resolves nothing.
        referredOrg: identity?.name ?? "A new customer",
      },
    });
  } catch (err) {
    // Never let a notification touch the money it is describing.
    console.error(
      `[billing-service] referral-reward-opened notification failed for promise ${promise.id}`,
      err
    );
  }
}

/**
 * Why this credit exists, in the recipient's own terms.
 *
 * Composed here rather than branched in the template, because the two sides of a
 * referral earned the same amount for opposite reasons: an inviter through
 * somebody else's signup, an invitee through their own. It is also the only place
 * the granted message can name the referral, which matters most in the case where
 * the reward was earned the instant it opened and this is the ONLY message the
 * referrer receives about it.
 */
function grantReason(
  promise: FreeCreditPromise,
  referredOrgName: string | null
): string {
  if (!promise.referredOrgId) {
    return "These are the referral credits for joining through an invite link.";
  }
  if (referredOrgName) {
    return `This is your referral reward for ${referredOrgName} joining through your invite link.`;
  }
  return "This is your referral reward for a customer who joined through your invite link.";
}

/** Tell whoever just had a referral reward credited that it landed. */
export async function notifyReferralCreditsGranted(
  promise: FreeCreditPromise
): Promise<void> {
  try {
    // Recipient first, then claim — see notifyReferralRewardOpened.
    const recipientEmail = await recipientFor(promise.orgId);
    if (!recipientEmail) return;

    if (!(await claimNotification(promise.id, "grantedNotifiedAt"))) return;

    const identity = promise.referredOrgId
      ? await resolveOrgDisplayIdentity(promise.referredOrgId)
      : null;

    sendEmail({
      eventType: REFERRAL_CREDITS_GRANTED_EVENT,
      orgId: promise.orgId,
      userId: SYSTEM_USER_ID,
      runId: crypto.randomUUID(),
      recipientEmail,
      metadata: {
        amount: dollars(promise.amountCents),
        reason: grantReason(promise, identity?.name ?? null),
      },
    });
  } catch (err) {
    console.error(
      `[billing-service] referral-credits-granted notification failed for promise ${promise.id}`,
      err
    );
  }
}
