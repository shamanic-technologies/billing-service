/**
 * Telling the REFERRER what they cannot see coming.
 *
 * A referral reward is held by the referrer and earned on the REFERRED org's
 * payments (see lib/free-credit-promises.ts). The referrer has no reason to open the
 * dashboard on either day that matters, so two messages, both to the referrer:
 *
 *   - `referral-reward-opened` → when someone signs up through their invite link:
 *     "you get $500 in free credits once <org> has paid $500".
 *   - `referral-credits-granted` → when the referred org's payments cross the bar
 *     and the credits land.
 *
 * The REFERRED org is never told it gets anything: it gets nothing from the referral.
 *
 * Deliberately NOT sent: "opened" when the reward is ALREADY earned the moment it
 * opens (the referred org has already paid the bar). `alreadyEarned` collapses that
 * pair down to the granted message, which names the same referral.
 *
 * ## Exactly once
 *
 * Each message claims its own marker column with a CONDITIONAL update that only
 * matches while the marker is still NULL, and only the caller whose update returns a
 * row sends. Two racing settles produce one email, a replayed payment none.
 *
 * ## Every send needs a REAL run
 *
 * transactional-email-service records each send as a run child of the `x-run-id`
 * it is handed, so that header must name a run runs-service already knows. There
 * is no end user here, so this module opens a PLATFORM run per message
 * (`createPlatformRun`) and closes it afterwards. A minted-on-the-spot UUID is
 * silently fatal: the email service answers 200 with `{sent: false, ...}`.
 *
 * ## Fail-soft, deliberately
 *
 * The documented exception to this repo's fail-loud rule: the promise is the
 * money-bearing information and the mail is not. A recipient we cannot resolve, or a
 * send that throws, logs loudly and returns. It never fails, delays or rolls back a
 * grant or a claim.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { freeCreditPromises, type FreeCreditPromise } from "../db/schema.js";
import { sendEmail } from "./email-client.js";
import {
  fetchOrgCustomer,
  sumSucceededTopupsForOrg,
} from "./stripe-service-client.js";
import { resolveOrgDisplayIdentity } from "./brand-service-client.js";
import { completePlatformRun, createPlatformRun } from "./runs-client.js";
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

/**
 * Open the run the email service will hang its own send under.
 *
 * NOT optional and NOT cosmetic: transactional-email-service creates its send as a
 * child of the `x-run-id` it receives, so runs-service rejects a parent that does
 * not exist and the email service answers 200 with
 * `{sent: false, reason: "Run creation failed: parentRunId <uuid> does not exist"}`.
 * A `crypto.randomUUID()` here would drop every referral message on the floor, and
 * since the send is fire-and-forget nothing would ever surface it. Verified
 * against prod: a random id yields `sent: false`, a real platform run `sent: true`.
 *
 * Null when no run could be opened, which the callers treat exactly like an
 * unresolvable recipient — skip without claiming the marker, so the next sweep
 * retries instead of losing the message.
 */
async function openNotificationRun(eventType: string): Promise<string | null> {
  return createPlatformRun(`referral-notification:${eventType}`);
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
 * Is this reward ALREADY earned the moment it opens — has the REFERRED org already
 * paid the bar? Then the granted message carries the whole story.
 *
 * Fail-OPEN: a paid-topups read that throws yields false, so the referrer is told.
 * A possible duplicate beats silence about money.
 */
async function alreadyEarned(promise: FreeCreditPromise): Promise<boolean> {
  if (!promise.referredOrgId) return false;
  try {
    const paid = await sumSucceededTopupsForOrg(promise.referredOrgId);
    return gte(paid, new Decimal(promise.paidTriggerCents).toFixed(10));
  } catch (err) {
    console.error(
      `[billing-service] referral notification: could not read paid topups for referred org ${promise.referredOrgId}, assuming the reward is not yet earned:`,
      err
    );
    return false;
  }
}

/**
 * Tell the REFERRER that someone signed up through their invite link, and what
 * that org must pay before the reward lands.
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

    // Also before claiming, for the same reason: no run means the email service
    // would refuse the send, and burning the marker would lose it for good.
    const runId = await openNotificationRun(REFERRAL_REWARD_OPENED_EVENT);
    if (!runId) return;

    if (!(await claimNotification(promise.id, "openedNotifiedAt"))) return;

    const identity = promise.referredOrgId
      ? await resolveOrgDisplayIdentity(promise.referredOrgId)
      : null;

    sendEmail({
      eventType: REFERRAL_REWARD_OPENED_EVENT,
      orgId: promise.orgId,
      userId: SYSTEM_USER_ID,
      runId,
      recipientEmail,
      metadata: {
        amount: dollars(promise.amountCents),
        unlockAt: dollars(promise.paidTriggerCents),
        // Always a real phrase, never blank: the name sits mid-sentence, and an
        // empty substitution would leave a hole there. "a new customer" names
        // nobody, which is the honest rendering when the lookup resolves nothing
        // (a brand-new org often has no brand yet).
        referredOrg: identity?.name ?? "a new customer",
      },
    });
    await completePlatformRun(runId);
  } catch (err) {
    // Never let a notification touch the money it is describing.
    console.error(
      `[billing-service] referral-reward-opened notification failed for promise ${promise.id}`,
      err
    );
  }
}

/** Why this credit exists, naming the referral when we can. */
function grantReason(referredOrgName: string | null): string {
  if (referredOrgName) {
    return `This is your referral reward: ${referredOrgName} joined through your invite link and has now paid us.`;
  }
  return "This is your referral reward: a customer who joined through your invite link has now paid us.";
}

/** Tell the referrer their referral reward landed. */
export async function notifyReferralCreditsGranted(
  promise: FreeCreditPromise
): Promise<void> {
  try {
    // Recipient and run first, then claim — see notifyReferralRewardOpened.
    const recipientEmail = await recipientFor(promise.orgId);
    if (!recipientEmail) return;

    const runId = await openNotificationRun(REFERRAL_CREDITS_GRANTED_EVENT);
    if (!runId) return;

    if (!(await claimNotification(promise.id, "grantedNotifiedAt"))) return;

    const identity = promise.referredOrgId
      ? await resolveOrgDisplayIdentity(promise.referredOrgId)
      : null;

    sendEmail({
      eventType: REFERRAL_CREDITS_GRANTED_EVENT,
      orgId: promise.orgId,
      userId: SYSTEM_USER_ID,
      runId,
      recipientEmail,
      metadata: {
        amount: dollars(promise.amountCents),
        reason: grantReason(identity?.name ?? null),
      },
    });
    await completePlatformRun(runId);
  } catch (err) {
    console.error(
      `[billing-service] referral-credits-granted notification failed for promise ${promise.id}`,
      err
    );
  }
}
