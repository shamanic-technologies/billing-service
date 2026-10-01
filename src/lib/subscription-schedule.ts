/**
 * The calendar of a billing-owned subscription (lib/subscription), pure: when the
 * next period starts, and every charge billing expects to make over a horizon. Its
 * own module so the payment outlook and the charge schedule can read it without
 * importing the subscription engine.
 */
import type { Subscription, SubscriptionCharge } from "../db/schema.js";
import { nextRetryDueAt } from "./campaign-reload-sweep.js";

/**
 * The period after one ending at `boundary`, on the ANNIVERSARY day of `anchor`
 * (the trial end): the 31st stays the 31st, clamped to a short month's last day,
 * so a February never drags every later renewal to the 28th.
 */
export function nextPeriodEnd(boundary: Date, anchor: Date): Date {
  const y = boundary.getUTCFullYear();
  const m = boundary.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(anchor.getUTCDate(), lastDay);
  return new Date(
    Date.UTC(
      y,
      m,
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds()
    )
  );
}

/** The anchor every renewal is dated from: the trial end, else the start. */
export function renewalAnchor(sub: Subscription): Date {
  return sub.trialEndsAt ?? sub.createdAt;
}

export interface SubscriptionChargeDate {
  at: Date;
  amountCents: number;
  trigger: "subscription_renewal" | "retry_rung";
}

/**
 * Every charge billing expects for this subscription up to `end`:
 *  - trialing / active, no cancel pending → the plan amount at each renewal
 *    (the trial end first), monthly on the anniversary;
 *  - past_due → ONE attempt at the next retry rung, nothing after (a schedule
 *    built on the bank saying yes is not ours to promise);
 *  - cancel pending, ended → none.
 */
export function subscriptionChargeDates(
  sub: Subscription,
  currentCharge: SubscriptionCharge | null,
  end: Date
): SubscriptionChargeDate[] {
  if (sub.status === "canceled") return [];
  if (sub.status === "past_due") {
    if (sub.cancelAtPeriodEnd || !currentCharge || currentCharge.status !== "failed") return [];
    if (!currentCharge.firstFailedAt) return [];
    const due = nextRetryDueAt(currentCharge.attemptCount, currentCharge.firstFailedAt);
    if (!due || due > end) return [];
    return [{ at: due, amountCents: currentCharge.amountCents, trigger: "retry_rung" }];
  }
  if (sub.cancelAtPeriodEnd) return [];
  const out: SubscriptionChargeDate[] = [];
  const anchor = renewalAnchor(sub);
  let at = sub.currentPeriodEnd;
  while (at <= end && out.length < 24) {
    out.push({ at, amountCents: sub.monthlyAmountCents, trigger: "subscription_renewal" });
    at = nextPeriodEnd(at, anchor);
  }
  return out;
}
