/**
 * Staff notification on a per-brand daily-budget change.
 *
 * A customer changing a brand's daily budget is the most business-critical
 * action we can observe: a drop to zero is a churn signal, a raise is expansion,
 * and the first value a new customer picks is the deal size. billing-service
 * owns the ONLY write path for that value in the fleet, so it is the only place
 * that can observe every change.
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
 * notification failure (email service down, misconfigured, slow, erroring) must
 * never change its status code, its body, or throw. This is the documented
 * exception to the fail-loud convention, and the reason the send is not awaited.
 */

import { Decimal } from "decimal.js";
import { cmpCents } from "./cents.js";
import { sendEmail } from "./email-client.js";

/** Byte-equal to the transactional-email-service event key AND template name. */
export const BRAND_DAILY_BUDGET_CHANGED_EVENT = "brand_daily_budget_changed";

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
  /** Value stored before this write; null on a first-ever set. */
  previousDailyBudgetCents: string | null;
  /** Value stored by this write. */
  newDailyBudgetCents: string;
  /**
   * Acting staff/user email when the gateway forwarded one (`x-email`). Left
   * absent so the email service fills `email` from `x-user-id` — it only
   * enriches when the caller supplied nothing.
   */
  actingEmail?: string | null;
}

/**
 * Notify staff of a real daily-budget change. A re-save of the SAME value is not
 * a change and sends nothing; a first-ever set does notify, with the "from" side
 * shown as unset.
 *
 * Never throws — see the module doc.
 */
export function notifyBrandDailyBudgetChanged(
  params: BrandDailyBudgetChangeNotification
): void {
  try {
    const { previousDailyBudgetCents, newDailyBudgetCents } = params;
    const isChange =
      previousDailyBudgetCents === null ||
      cmpCents(previousDailyBudgetCents, newDailyBudgetCents) !== 0;
    if (!isChange) return;

    const previousBudget = formatDailyBudget(previousDailyBudgetCents);
    const newBudget = formatDailyBudget(newDailyBudgetCents);

    const metadata: Record<string, string | null> = {
      brandId: params.brandId,
      orgId: params.orgId,
      previousBudget,
      newBudget,
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
