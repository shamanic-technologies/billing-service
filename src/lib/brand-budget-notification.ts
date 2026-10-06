/**
 * Staff notification on a per-brand daily-budget change.
 *
 * A customer changing a brand's daily budget is the most business-critical
 * action we can observe: a drop to zero is a churn signal, a raise is expansion,
 * and the first value a new customer picks is the deal size. billing-service
 * owns the ONLY write path for that value in the fleet, so it is the only place
 * that can observe every change.
 *
 * ONE LINE PER MISSION, NEVER A BRAND SUM. A brand's ceilings are missions
 * (offer x leg x channel) of two kinds: an entry leg spends DAILY, a leg that
 * starts from a step (e.g. AI meeting booking, from a positive reply) is a
 * REACTIVE cap that only spends when triggered. Summing them misstates both:
 * on 2026-09-29 NOVEMIQ's Herald went $10 -> $7/day and staff read
 * "$13/day -> $10/day" with UUIDs for names. The email now names each changed
 * mission, states the daily total over running entry legs only, and lists
 * reactive caps and paused missions apart. See `budget-change-email.ts` (the
 * words) and `budget-change-context.ts` (the fail-soft reads of the names).
 *
 * Channel: the existing fire-and-forget transactional-email-service client.
 * transactional-email-service routes the `brand_daily_budget_changed` event to
 * its own staff recipient list instead of to the customer (PR #108) and enriches
 * the metadata with the acting user's email when the caller supplies none — so
 * no staff address is named here, and no second recipient list exists.
 *
 * The event key is byte-equal to the template name registered at boot
 * (src/instrument.ts): the email service resolves a template by looking up the
 * row whose `name` equals the event type.
 *
 * STRICTLY fire-and-forget: the budget write is customer-facing, so a
 * notification failure (email service down, campaign-service down,
 * misconfigured, slow, erroring) must never change its status code, its body,
 * its latency, or throw. This is the documented exception to the fail-loud
 * convention, and the reason neither the campaign-service read nor the send is
 * awaited by any route.
 */

import { Decimal } from "decimal.js";
import { cmpCents } from "./cents.js";
import { sendEmail } from "./email-client.js";
import { fetchSpendableBudget } from "./campaign-service-client.js";
import type { CeilingChange } from "./brand-running-budget.js";
import {
  fetchBrandName,
  fetchChannelCatalogue,
  fetchOfferNames,
  fetchOrgIdentity,
} from "./budget-change-context.js";
import {
  buildBudgetChangeEmail,
  type BudgetChangeEmail,
  type MissionCeiling,
  type MissionStatusMove,
} from "./budget-change-email.js";
import { getBrandCeilings } from "./campaign-budgets.js";
import { getBrandDailyBudget } from "./brand-budgets.js";

/** Byte-equal to the transactional-email-service event key AND template name. */
export const BRAND_DAILY_BUDGET_CHANGED_EVENT = "brand_daily_budget_changed";

/**
 * Render a stored fractional-cents budget as a whole-dollar daily figure.
 * Zero is a deliberate pause; null is the never-configured state.
 */
export function formatDailyBudget(cents: string | null): string {
  if (cents === null) return "unset";
  const dollars = new Decimal(cents).dividedBy(100);
  if (dollars.isZero()) return "paused ($0/day)";
  return `$${dollars.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0)}/day`;
}

export interface BrandDailyBudgetChangeNotification {
  orgId: string;
  userId: string;
  runId: string;
  brandId: string;
  /** Brand-level total stored before this write; null on a first-ever set. */
  previousDailyBudgetCents: string | null;
  /** Brand-level total stored by this write. */
  newDailyBudgetCents: string;
  /** Every ceiling this write touched, with its before and after value. */
  changes: CeilingChange[];
  /**
   * Every ceiling as it stands AFTER the write (a brand-grain write passes its
   * scalar with every grain field null). The email lists these, split into
   * daily money, reactive caps and paused missions.
   */
  ceilings: MissionCeiling[];
  /**
   * Acting staff/user email when the gateway forwarded one (`x-email`). Left
   * absent so the email service fills `email` from `x-user-id` — it only
   * enriches when the caller supplied nothing.
   */
  actingEmail?: string | null;
}

/**
 * ONE send path for both notifications (a budget write and a status change), so
 * the two cannot drift: same event, same template, same variables.
 */
export function sendStaffEmail(
  params: { orgId: string; userId: string; runId: string; actingEmail?: string | null },
  email: BudgetChangeEmail
): void {
  const metadata: Record<string, string | null> = {
    action: email.action,
    actionHtml: email.actionHtml,
    subject: email.subject,
    summaryHtml: email.summaryHtml,
    summaryText: email.summaryText,
  };
  if (params.actingEmail) metadata.email = params.actingEmail;

  sendEmail({
    eventType: BRAND_DAILY_BUDGET_CHANGED_EVENT,
    orgId: params.orgId,
    userId: params.userId,
    runId: params.runId,
    metadata,
  });
}

/** True when this write moved the brand total OR any individual ceiling. */
function isRealChange(params: BrandDailyBudgetChangeNotification): boolean {
  if (
    params.previousDailyBudgetCents === null ||
    cmpCents(params.previousDailyBudgetCents, params.newDailyBudgetCents) !== 0
  ) {
    return true;
  }
  // A reallocation that keeps the brand total identical still moves money
  // between missions.
  return params.changes.some(
    (c) =>
      cmpCents(c.previousDailyBudgetCents, c.newDailyBudgetCents) !== 0
  );
}

/**
 * Notify staff of a real daily-budget change. A re-save of the SAME value is not
 * a change and sends nothing; a first-ever set does notify.
 *
 * Never throws and never rejects — see the module doc. Returns a promise ONLY so
 * callers can await it in tests; no route awaits it.
 */
export async function notifyBrandDailyBudgetChanged(
  params: BrandDailyBudgetChangeNotification
): Promise<void> {
  try {
    if (!isRealChange(params)) return;

    // The write has already committed, so every read sees the NEW state. All
    // five are fail-soft; the email says in words which part is missing.
    const [spendable, catalogue, brandName, offerNames, org] = await Promise.all([
      fetchSpendableBudget(params.orgId, params.brandId),
      fetchChannelCatalogue(),
      fetchBrandName(params.orgId, params.brandId),
      fetchOfferNames(params.orgId, params.brandId),
      fetchOrgIdentity(params.orgId),
    ]);

    const email = buildBudgetChangeEmail({
      brandId: params.brandId,
      orgId: params.orgId,
      firstBudget: params.previousDailyBudgetCents === null,
      changes: params.changes,
      ceilings: params.ceilings,
      brandName,
      org,
      offerNames,
      catalogue,
      spendable,
    });

    sendStaffEmail(params, email);
  } catch (err) {
    console.error(
      "[billing-service] failed to notify staff of a brand daily-budget change:",
      err
    );
  }
}

// --- a person paused or restarted a mission ------------------------------------
//
// campaign-service owns a campaign's status; pausing a mission changes the
// brand's real daily spend exactly as lowering its ceiling does, so staff get
// the SAME email. campaign-service tells billing that a status moved (after its
// own write committed) and billing composes: the ceilings are billing's, the
// running split is read back from campaign-service and already reflects the move.

/** campaign-service's two stored statuses a person can move a mission between. */
export function statusMoveOf(
  fromStatus: string | null,
  toStatus: string
): MissionStatusMove | null {
  if (fromStatus === toStatus) return null;
  if (toStatus === "stopped") return "paused";
  if (toStatus === "ongoing") return "restarted";
  return null;
}

export interface MissionStatusChangeNotification {
  orgId: string;
  userId: string;
  runId: string;
  brandId: string;
  campaignId: string;
  featureSlug: string | null;
  offerId: string | null;
  legKey: string | null;
  fromStatus: string | null;
  toStatus: string;
  actingEmail?: string | null;
}

async function readCeilingsAfter(
  orgId: string,
  brandId: string
): Promise<MissionCeiling[] | null> {
  try {
    const rows = await getBrandCeilings(orgId, brandId);
    if (rows.length > 0) return rows;
    const brandPot = await getBrandDailyBudget(orgId, brandId);
    return brandPot
      ? [{ featureSlug: null, offerId: null, legKey: null, dailyBudgetCents: brandPot.dailyBudgetCents }]
      : [];
  } catch (err) {
    console.error(
      `[billing-service] ceiling read failed for the mission status email, brand=${brandId}:`,
      err
    );
    return null;
  }
}

/**
 * Notify staff that a person paused or restarted a mission. A move that is not
 * a real transition between running and paused sends nothing.
 *
 * Never throws and never rejects — the same fire-and-forget posture as the
 * budget notification. Returns whether an email was handed to the sender, so
 * the route and the tests can say so.
 */
export async function notifyMissionStatusChanged(
  params: MissionStatusChangeNotification
): Promise<boolean> {
  try {
    const move = statusMoveOf(params.fromStatus, params.toStatus);
    if (!move) return false;

    const [ceilings, spendable, catalogue, brandName, offerNames, org] = await Promise.all([
      readCeilingsAfter(params.orgId, params.brandId),
      fetchSpendableBudget(params.orgId, params.brandId),
      fetchChannelCatalogue(),
      fetchBrandName(params.orgId, params.brandId),
      fetchOfferNames(params.orgId, params.brandId),
      fetchOrgIdentity(params.orgId),
    ]);

    const email = buildBudgetChangeEmail({
      brandId: params.brandId,
      orgId: params.orgId,
      firstBudget: false,
      changes: [],
      statusChanges: [
        {
          featureSlug: params.featureSlug,
          offerId: params.offerId,
          legKey: params.legKey,
          move,
        },
      ],
      ceilings: ceilings ?? [],
      ceilingsUnavailable: ceilings === null,
      brandName,
      org,
      offerNames,
      catalogue,
      spendable,
    });

    sendStaffEmail(params, email);
    return true;
  } catch (err) {
    console.error(
      `[billing-service] failed to notify staff of a mission status change (campaign=${params.campaignId}):`,
      err
    );
    return false;
  }
}
