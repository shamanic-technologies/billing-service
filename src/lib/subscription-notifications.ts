/**
 * "Your month of outreach is booked" — the email a SUBSCRIPTION org gets when it has
 * used all of a period's credit (lib/subscription). Owner rule (2026-10-01): a
 * limit reached is a SUCCESS to celebrate, never a shortage. It states what was
 * lined up (or sent, once it was), the results to expect, and invites a bigger
 * plan. Never "credits exhausted". Copy + layout: lib/subscription-credits-used-email.
 *
 * It REPLACES the generic out-of-credit dunning for subscription orgs (no
 * depletion episode is opened for them, lib/dunning): running out of the month's
 * credit is the plan working, not a payment problem.
 *
 * Once per PERIOD, claimed on `subscriptions.credits_used_notified_period_start`
 * (conditional UPDATE … RETURNING, so two racing ticks send one email), and only
 * AFTER the recipient and a real platform run are resolved: anything we could not
 * resolve leaves the marker unset and the next tick retries.
 *
 * Every performance figure comes ready from features-service (the owner of what
 * the dashboard shows); billing computes none. A figure it could not state drops
 * its sentence, never 0. Fail-soft: nothing here can affect money.
 */

import { and, eq, isNull, ne, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { PLATFORM_USER_ID, subscriptions, type Subscription } from "../db/schema.js";
import { computeBalance } from "./balance.js";
import { resolveSpendBlock, cannotSpend } from "./spend-block.js";
import { fetchOrgCustomerOrNull } from "./stripe-service-client.js";
import { fetchBrandName, fetchOrgIdentity } from "./budget-change-context.js";
import { createPlatformRun, completePlatformRun } from "./runs-client.js";
import { sendEmail } from "./email-client.js";
import { fetchSubscriptionRecap } from "./subscription-recap-client.js";
import { composeCreditsUsedEmail } from "./subscription-credits-used-email.js";

export const SUBSCRIPTION_CREDITS_USED_EVENT = "subscription-credits-used";
export const DASHBOARD_URL = "https://dashboard.distribute.you";

/** Has this org used all the credit it can spend right now (floor 0)? */
async function creditsUsed(orgId: string): Promise<boolean> {
  const snapshot = await computeBalance(orgId);
  const block = await resolveSpendBlock(orgId, snapshot);
  return cannotSpend(snapshot.balanceCents, block.requiredCents, "0");
}

/**
 * Send the email once for the subscription's current period, when its credit is
 * used up. Never throws.
 */
export async function notifySubscriptionCreditsUsedIfDue(
  orgId: string,
  sub: Subscription | null
): Promise<void> {
  try {
    if (!sub || (sub.status !== "trialing" && sub.status !== "active")) return;
    const period = sub.currentPeriodStart;
    if (sub.creditsUsedNotifiedPeriodStart?.getTime() === period.getTime()) return;
    if (!(await creditsUsed(orgId))) return;

    const customer = await fetchOrgCustomerOrNull(orgId);
    const recipientEmail = customer?.email ?? null;
    const userId = sub.startedByUserId ?? PLATFORM_USER_ID;
    if (!recipientEmail && !sub.startedByUserId) {
      console.warn(`[billing-service] credits-used email: org ${orgId} has no recipient`);
      return;
    }

    const runId = await createPlatformRun("subscription-credits-used");
    if (!runId) {
      console.error(`[billing-service] credits-used email for org ${orgId}: no platform run, retried next tick`);
      return;
    }

    const claimed = await db
      .update(subscriptions)
      .set({ creditsUsedNotifiedPeriodStart: period })
      .where(
        and(
          eq(subscriptions.id, sub.id),
          or(
            isNull(subscriptions.creditsUsedNotifiedPeriodStart),
            ne(subscriptions.creditsUsedNotifiedPeriodStart, period)
          )
        )
      )
      .returning({ id: subscriptions.id });
    if (claimed.length === 0) {
      await completePlatformRun(runId);
      return;
    }

    const [recap, identity, brandName] = await Promise.all([
      fetchSubscriptionRecap(orgId, period, new Date()),
      fetchOrgIdentity(orgId),
      sub.brandId ? fetchBrandName(orgId, sub.brandId) : Promise.resolve(null),
    ]);
    const ctaUrl = identity?.externalId
      ? `${DASHBOARD_URL}/orgs/${identity.externalId}/billing`
      : DASHBOARD_URL;
    const email = composeCreditsUsedEmail({
      recap,
      monthlyAmountCents: sub.monthlyAmountCents,
      brandName,
      ctaUrl,
    });
    sendEmail({
      eventType: SUBSCRIPTION_CREDITS_USED_EVENT,
      orgId,
      userId,
      runId,
      recipientEmail,
      metadata: { ...email },
    });
    await completePlatformRun(runId);
    console.log(`[billing-service] credits-used email sent for org ${orgId} (period ${period.toISOString()})`);
  } catch (err) {
    console.error(`[billing-service] credits-used email failed for org ${orgId}:`, err);
  }
}
