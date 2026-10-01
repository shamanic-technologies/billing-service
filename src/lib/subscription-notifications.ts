/**
 * "All your outbound went out" — the email a SUBSCRIPTION org gets when it has
 * used all of a period's credit (lib/subscription). Owner rule (2026-10-01): a
 * limit reached is a SUCCESS to celebrate, never a shortage. It states what went
 * out, the results to expect, and invites a bigger plan. Never "credits exhausted".
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
import { fetchOrgIdentity } from "./budget-change-context.js";
import { createPlatformRun, completePlatformRun } from "./runs-client.js";
import { sendEmail } from "./email-client.js";
import { fetchSubscriptionRecap, type SubscriptionRecap } from "./subscription-recap-client.js";
import { SUBSCRIPTION_STEP_CENTS } from "./subscription.js";

export const SUBSCRIPTION_CREDITS_USED_EVENT = "subscription-credits-used";
export const DASHBOARD_URL = "https://dashboard.distribute.you";

function dollars(cents: number): string {
  const d = cents / 100;
  return Number.isInteger(d) ? `$${d.toLocaleString("en-US")}` : `$${d.toFixed(2)}`;
}

function times(x: number): string {
  return `${x.toFixed(1).replace(/\.0$/, "")}x`;
}

export interface CreditsUsedEmail {
  subject: string;
  intro: string;
  results: string;
  upsell: string;
  ctaLabel: string;
  ctaUrl: string;
}

/**
 * The email, composed in code so every template variable is always a non-empty
 * sentence (an unset `{{var}}` renders literally in a customer's inbox). Pure.
 */
export function composeCreditsUsedEmail(params: {
  recap: SubscriptionRecap | null;
  monthlyAmountCents: number;
  ctaUrl: string;
}): CreditsUsedEmail {
  const r = params.recap;
  const sent = r?.sentCount ?? null;
  const intro =
    sent !== null && sent > 0
      ? `Congratulations, all ${sent.toLocaleString("en-US")} emails of this month's outbound went out successfully.` +
        (r?.deliveryRatePct != null ? ` ${Math.round(r.deliveryRatePct)}% were delivered.` : "")
      : "Congratulations, all of this month's outbound went out successfully." +
        (r?.deliveryRatePct != null ? ` ${Math.round(r.deliveryRatePct)}% was delivered.` : "");

  let results = "";
  if (r?.expectedPositiveReplies != null && r.expectedPositiveReplies > 0) {
    const n = Math.max(1, Math.round(r.expectedPositiveReplies));
    results = `On this volume we expect about ${n} positive ${n === 1 ? "reply" : "replies"}`;
    if (r.expectedRoiMultiple != null && r.lifetimeRevenueUsd != null) {
      results += `, for a ${times(r.expectedRoiMultiple)} return based on your ${dollars(
        r.lifetimeRevenueUsd * 100
      )} lifetime revenue per client.`;
    } else {
      results += ".";
    }
  } else if (r?.expectedRoiMultiple != null && r.lifetimeRevenueUsd != null) {
    results = `We expect a ${times(r.expectedRoiMultiple)} return on this month, based on your ${dollars(
      r.lifetimeRevenueUsd * 100
    )} lifetime revenue per client.`;
  }

  const nextPlan = params.monthlyAmountCents + SUBSCRIPTION_STEP_CENTS;
  const upsell =
    r?.raiseRevenueMultiple != null
      ? `We strongly recommend raising your plan: +$100 a month would bring about ${times(
          r.raiseRevenueMultiple
        )} the revenue at your current results.`
      : `We strongly recommend raising your plan to ${dollars(nextPlan)} a month to reach more prospects while your campaigns are performing.`;

  return {
    subject: "All your outbound went out 🎉",
    intro,
    results,
    upsell,
    ctaLabel: `Raise my plan to ${dollars(nextPlan)}/month`,
    ctaUrl: params.ctaUrl,
  };
}

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

    const [recap, identity] = await Promise.all([
      fetchSubscriptionRecap(orgId, period, new Date()),
      fetchOrgIdentity(orgId),
    ]);
    const ctaUrl = identity?.externalId
      ? `${DASHBOARD_URL}/orgs/${identity.externalId}/billing`
      : DASHBOARD_URL;
    const email = composeCreditsUsedEmail({
      recap,
      monthlyAmountCents: sub.monthlyAmountCents,
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
