/**
 * The informational monthly update (owner 2026-10-04, lyon-v3 relay + review in
 * this repo): every subscription org gets "Your month for <brand>" at the END of
 * each period, independent of credit consumption. Copy:
 * lib/subscription-monthly-update-email.
 *
 * Timing: the hourly subscription sweep calls this after advancing the plan. A
 * period is "closed" once `current_period_start` has moved past the end of the
 * last reported window (`monthly_update_reported_through`, NULL = the plan's first
 * period start). The report covers exactly [last reported end, current period
 * start). A window shorter than MIN_WINDOW_DAYS (the 3-day trial ending, a
 * start-now) is not reported on its own: it rolls into the next one, so nobody
 * gets "your month" after three days.
 *
 * Who: the org's PRIMARY plan only (the recap is org-wide, one email per org);
 * trialing or active; never while paused or past_due (the payment mail speaks).
 *
 * Once per window, claimed by a conditional UPDATE … RETURNING on the column, and
 * only AFTER the recap, the recipient and a real platform run are resolved:
 * anything unresolved leaves it unclaimed and the next tick retries. A window
 * with nothing lined up or sent is claimed and not mailed (nothing to say).
 * Fail-soft: never throws, nothing here touches money.
 */
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { PLATFORM_USER_ID, subscriptions, type Subscription } from "../db/schema.js";
import { fetchOrgCustomerOrNull } from "./stripe-service-client.js";
import { fetchBrandName, fetchOrgIdentity } from "./budget-change-context.js";
import { createPlatformRun, completePlatformRun } from "./runs-client.js";
import { sendEmail } from "./email-client.js";
import { fetchSubscriptionRecap } from "./subscription-recap-client.js";
import { DASHBOARD_URL } from "./subscription-email-format.js";
import { composeMonthlyUpdateEmail, recapHasActivity } from "./subscription-monthly-update-email.js";

export const SUBSCRIPTION_MONTHLY_UPDATE_EVENT = "subscription-monthly-update";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A closed window shorter than this rolls into the next report. */
export const MIN_WINDOW_DAYS = 7;
/** features-service's recap accepts at most 93 days; a longer gap reports its last 92. */
const MAX_WINDOW_DAYS = 92;

/** The window this plan would report now, or null when no full window has closed. */
export function dueMonthlyUpdateWindow(sub: Subscription): { from: Date; to: Date } | null {
  if (sub.status !== "trialing" && sub.status !== "active") return null;
  if (sub.pausedAt) return null;
  const from = sub.monthlyUpdateReportedThrough ?? sub.trialStartedAt ?? sub.createdAt;
  const to = sub.currentPeriodStart;
  if (to.getTime() - from.getTime() < MIN_WINDOW_DAYS * DAY_MS) return null;
  return { from, to };
}

/** Send the update for the plan's last closed window, once. Never throws. */
export async function notifySubscriptionMonthlyUpdateIfDue(
  orgId: string,
  sub: Subscription | null
): Promise<void> {
  try {
    if (!sub) return;
    const window = dueMonthlyUpdateWindow(sub);
    if (!window) return;

    // Recap days are inclusive: the last day is the one before the new period.
    const lastDay = new Date(window.to.getTime() - 1);
    const firstDay = new Date(Math.max(window.from.getTime(), lastDay.getTime() - MAX_WINDOW_DAYS * DAY_MS));
    const recap = await fetchSubscriptionRecap(orgId, firstDay, lastDay);
    if (!recap) {
      console.warn(`[billing-service] monthly update for org ${orgId}: recap unavailable, retried next tick`);
      return;
    }

    const customer = await fetchOrgCustomerOrNull(orgId);
    const recipientEmail = customer?.email ?? null;
    if (!recipientEmail && !sub.startedByUserId) {
      console.warn(`[billing-service] monthly update: org ${orgId} has no recipient`);
      return;
    }

    const hasActivity = recapHasActivity(recap);
    const runId = hasActivity ? await createPlatformRun("subscription-monthly-update") : null;
    if (hasActivity && !runId) {
      console.error(`[billing-service] monthly update for org ${orgId}: no platform run, retried next tick`);
      return;
    }

    const claimed = await db
      .update(subscriptions)
      .set({ monthlyUpdateReportedThrough: window.to })
      .where(
        and(
          eq(subscriptions.id, sub.id),
          or(
            isNull(subscriptions.monthlyUpdateReportedThrough),
            lt(subscriptions.monthlyUpdateReportedThrough, window.to)
          )
        )
      )
      .returning({ id: subscriptions.id });
    if (claimed.length === 0) {
      if (runId) await completePlatformRun(runId);
      return;
    }
    if (!hasActivity || !runId) {
      console.log(
        `[billing-service] monthly update for org ${orgId}: nothing lined up or sent through ${window.to.toISOString()}, not mailed`
      );
      return;
    }

    const [identity, brandName] = await Promise.all([
      fetchOrgIdentity(orgId),
      sub.brandId ? fetchBrandName(orgId, sub.brandId) : Promise.resolve(null),
    ]);
    const ctaUrl = identity?.externalId ? `${DASHBOARD_URL}/orgs/${identity.externalId}` : DASHBOARD_URL;
    const email = composeMonthlyUpdateEmail({ recap, brandName, ctaUrl });
    sendEmail({
      eventType: SUBSCRIPTION_MONTHLY_UPDATE_EVENT,
      orgId,
      userId: sub.startedByUserId ?? PLATFORM_USER_ID,
      runId,
      recipientEmail,
      metadata: { ...email },
    });
    await completePlatformRun(runId);
    console.log(
      `[billing-service] monthly update sent for org ${orgId} (${window.from.toISOString()} to ${window.to.toISOString()})`
    );
  } catch (err) {
    console.error(`[billing-service] monthly update failed for org ${orgId}:`, err);
  }
}
