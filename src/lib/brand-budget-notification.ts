/**
 * Staff notification on a per-brand daily-budget change.
 *
 * A customer changing a brand's daily budget is the most business-critical
 * action we can observe: a drop to zero is a churn signal, a raise is expansion,
 * and the first value a new customer picks is the deal size. billing-service
 * owns the ONLY write path for that value in the fleet, so it is the only place
 * that can observe every change.
 *
 * THE HEADLINE IS THE RUNNING FIGURE, not the configured total. billing stores
 * no campaign status, so the total it can compute alone counts a ceiling whose
 * campaign has been stopped for weeks exactly like one sending today. Measured
 * in prod: a brand with $200/day behind an ongoing campaign and $10/day behind a
 * stopped one was reported as "$110/day → $210/day" on a raise that moved the
 * spendable figure $100 → $200. Every such message overstated the change by
 * whatever was paused. campaign-service answers the split (see
 * `campaign-service-client.ts`); the arithmetic for the BEFORE side is in
 * `brand-running-budget.ts`.
 *
 * THE CONFIGURED TOTAL IS STATED TOO, on its own line. Dropping it would hide
 * the paused money rather than surface it, and the paused money is the reason
 * the two figures differ.
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
import {
  runningTotalsFor,
  type CeilingChange,
} from "./brand-running-budget.js";

/** Byte-equal to the transactional-email-service event key AND template name. */
export const BRAND_DAILY_BUDGET_CHANGED_EVENT = "brand_daily_budget_changed";

/**
 * What the running lines say when campaign-service could not be read. NEVER a
 * configured figure wearing the running label — an overstated number is the bug
 * this whole change exists to remove, and a silently wrong one is worse than an
 * absent one.
 */
export const RUNNING_UNAVAILABLE = "unavailable";

/** Always supplied, never empty — an unset {{variable}} renders literally. */
export const RUNNING_NOTE_OK =
  "Running = the part of the configured budget attached to a campaign that is ongoing right now.";
export const RUNNING_NOTE_UNAVAILABLE =
  "Running split unavailable: campaign-service could not be read, so only the configured totals are known.";

/**
 * Render a stored fractional-cents budget as the staff-readable daily figure.
 *
 * A daily budget is a whole-dollar configuration value, so cents never show.
 * Zero is a deliberate pause, not "changed to 0" — it must read as such. null is
 * the never-configured state (a first-ever set has no "from" value).
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
  /**
   * Every ceiling this write touched, with its before and after value. Used to
   * carry the running figure back to the state before the write — statuses do
   * not move during a budget write, so the post-write running verdict per
   * ceiling applies to both sides. See `brand-running-budget.ts`.
   */
  changes: CeilingChange[];
  /**
   * Acting staff/user email when the gateway forwarded one (`x-email`). Left
   * absent so the email service fills `email` from `x-user-id` — it only
   * enriches when the caller supplied nothing.
   */
  actingEmail?: string | null;
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
  // between campaigns, so it can move the RUNNING total — which is the headline.
  return params.changes.some(
    (c) =>
      cmpCents(c.previousDailyBudgetCents, c.newDailyBudgetCents) !== 0
  );
}

/**
 * Notify staff of a real daily-budget change. A re-save of the SAME value is not
 * a change and sends nothing; a first-ever set does notify, with the "from" side
 * shown as unset. A change that only moved PAUSED money still sends — a paused
 * ceiling moving is a business signal, and the headline then reads unchanged.
 *
 * Never throws and never rejects — see the module doc. Returns a promise ONLY so
 * callers can await it in tests; no route awaits it.
 */
export async function notifyBrandDailyBudgetChanged(
  params: BrandDailyBudgetChangeNotification
): Promise<void> {
  try {
    if (!isRealChange(params)) return;

    const previousBudget = formatDailyBudget(params.previousDailyBudgetCents);
    const newBudget = formatDailyBudget(params.newDailyBudgetCents);

    // The write has already committed, so campaign-service reads the NEW
    // ceilings back — that is exactly the "now" side we want.
    const spendable = await fetchSpendableBudget(params.orgId, params.brandId);
    const running = spendable
      ? runningTotalsFor(spendable, params.changes)
      : null;

    const metadata: Record<string, string | null> = {
      brandId: params.brandId,
      orgId: params.orgId,
      // The headline, on both sides of the change.
      previousRunningBudget: running
        ? formatDailyBudget(running.runningBeforeCents)
        : RUNNING_UNAVAILABLE,
      newRunningBudget: running
        ? formatDailyBudget(running.runningNowCents)
        : RUNNING_UNAVAILABLE,
      // The configured totals, stated alongside so the paused money is visible
      // rather than silently dropped. Names unchanged — they have always meant
      // the configured figure.
      previousBudget,
      newBudget,
      runningNote: running ? RUNNING_NOTE_OK : RUNNING_NOTE_UNAVAILABLE,
    };
    if (params.actingEmail) metadata.email = params.actingEmail;

    sendEmail({
      eventType: BRAND_DAILY_BUDGET_CHANGED_EVENT,
      orgId: params.orgId,
      userId: params.userId,
      runId: params.runId,
      metadata,
    });
  } catch (err) {
    console.error(
      "[billing-service] failed to notify staff of a brand daily-budget change:",
      err
    );
  }
}
