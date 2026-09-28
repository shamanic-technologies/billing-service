/**
 * Every charge billing expects to present over a horizon, not only the next one.
 *
 * The payment outlook answers "when is the NEXT charge attempt". A cash forecast
 * needs the ones after it, and the only way to place them is to replay billing's
 * own charging rules forward — which is why this lives here and not in the
 * consumer: two copies of "floor or month-end, whichever comes first" drift.
 *
 * THE RULES REPLAYED, each imported rather than restated:
 *
 *  - FLOOR: a reload fires when `balance − required < floor` (`cannotSpend`), and
 *    charges whole multiples of the tier amount up to `floor + required`
 *    (`computeTopupCharge`, the authorize / reload-sweep arithmetic). At the
 *    crossing that is one unit.
 *  - MONTH END: on the last day at `SWEEP_HOUR_UTC`, a NEGATIVE balance is settled
 *    to exactly zero (`computeSettleCharge`, below the acquirer minimum → nothing,
 *    it rolls). A non-negative balance is left alone.
 *  - Every charge counts as a paid top-up, so the tier (and therefore the floor)
 *    is re-derived after each one (`reloadTierFor`), exactly as the live ladder
 *    does.
 *
 * THE PROJECTION IS A CONSTANT RATE: the measured realized burn, carried forward.
 * Not the configured ceiling (utilisation ran 4% to 146%, see lib/realized-burn).
 *
 * IT STARTS FROM THE OUTLOOK'S OWN DECISION, never a second one:
 *
 *  - `no_autopay`, `charge_blocked` without a retry date → no event, and the state
 *    + reason say why. Nothing is charged automatically for those orgs.
 *  - a refused card with a retry rung → ONE event at the rung, and nothing after
 *    it: whether the bank says yes is not ours to predict, so no schedule is
 *    built on the assumption that it will.
 *  - `unknown` (spend we cannot measure) → the month-end settle only when the org
 *    already owes, with a NULL amount: at least what is owed, by how much more we
 *    cannot say. Never a fabricated figure.
 *  - `charge_due_now` → the reload at `now`, then the replay.
 *  - `will_charge` / `idle` → the replay.
 *
 * Every date is a charge ATTEMPT, never a payment. Pure read: charges nothing,
 * reserves nothing, writes nothing.
 */

import { Decimal } from "decimal.js";
import { computeSettleCharge } from "./month-end-sweep.js";
import { computeTopupCharge, reloadTierFor } from "./topup-tier.js";
import { cannotSpend } from "./spend-block.js";
import {
  floorCrossingAt,
  nextMonthEndSweepAt,
  resolvePaymentOutlook,
  type PaymentBlockedReason,
  type PaymentChargeTrigger,
  type PaymentOutlookState,
} from "./payment-outlook.js";
import type { BurnUnavailableReason } from "./realized-burn.js";
import type { PaymentMode } from "./payment-mode-types.js";

export const DEFAULT_CHARGE_SCHEDULE_HORIZON_DAYS = 90;
export const MAX_CHARGE_SCHEDULE_HORIZON_DAYS = 366;

/** A replay that would emit more than this is a burn/tier combination nobody has. */
const MAX_EVENTS = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExpectedCharge {
  /** When billing expects to PRESENT the card (ISO 8601). */
  at: string;
  trigger: PaymentChargeTrigger;
  /**
   * Integer cents billing would ask for, as a string. Null only when the amount
   * cannot be established (unmeasured burn), never 0 as a stand-in.
   */
  expectedAmountCents: string | null;
  /** Projected balance just before the charge. Null when the burn is unmeasured. */
  projectedBalanceBeforeCents: string | null;
  /** Projected balance just after the charge lands. Null when unmeasured. */
  projectedBalanceAfterCents: string | null;
}

export interface ChargeSchedule {
  orgId: string;
  paymentMode: PaymentMode;
  /** The payment outlook's state — the same decision, read at the same instant. */
  state: PaymentOutlookState;
  blockedReason: PaymentBlockedReason | null;
  asOf: string;
  horizonDays: number;
  horizonEndsAt: string;
  balanceCents: string;
  floorCents: string;
  realizedDailyBurnCents: string | null;
  burnUnavailableReason: BurnUnavailableReason | null;
  burnWindowDays: number;
  /** Oldest first. Empty when billing expects no automatic charge. */
  events: ExpectedCharge[];
  /** Sum of the event amounts; null when any amount is unknown. */
  expectedTotalCents: string | null;
}

function fixed(d: Decimal): string {
  return d.toFixed(10);
}

/** Balance after `ms` of constant burn. */
function project(balance: Decimal, dailyBurn: Decimal, ms: number): Decimal {
  return balance.minus(dailyBurn.times(ms).dividedBy(DAY_MS));
}

/**
 * Replay floor reloads and month-end settles forward from `now` until `end`.
 * Exported pure so the rule-by-rule behaviour is pinned without a database.
 */
export function replayCharges(params: {
  now: Date;
  end: Date;
  balanceCents: string;
  paidTopupsCents: string;
  requiredCents: string;
  dailyBurnCents: string;
  paymentMode: PaymentMode;
  /** Present the floor reload at `now` first (the outlook said it is due). */
  dueNow: boolean;
}): ExpectedCharge[] {
  const events: ExpectedCharge[] = [];
  const burn = new Decimal(params.dailyBurnCents);
  const required = new Decimal(params.requiredCents);
  let balance = new Decimal(params.balanceCents);
  let paid = new Decimal(params.paidTopupsCents);
  let t = params.now;

  const charge = (at: Date, trigger: PaymentChargeTrigger, amount: number) => {
    const after = balance.plus(amount);
    events.push({
      at: at.toISOString(),
      trigger,
      expectedAmountCents: String(amount),
      projectedBalanceBeforeCents: fixed(balance),
      projectedBalanceAfterCents: fixed(after),
    });
    balance = after;
    paid = paid.plus(amount);
  };

  if (params.dueNow) {
    const tier = reloadTierFor(fixed(paid), params.paymentMode);
    const target = required.plus(tier.thresholdCents);
    const amount =
      computeTopupCharge(fixed(balance), fixed(target), tier.amountCents) ||
      tier.amountCents;
    charge(t, "floor", amount);
  }

  while (events.length < MAX_EVENTS) {
    const tier = reloadTierFor(fixed(paid), params.paymentMode);
    const floor = String(tier.thresholdCents);
    const target = required.plus(tier.thresholdCents);

    // Already unable to spend (a prepaid org settled to exactly zero, say): the
    // reload fires on the spot, never "at the crossing", which is in the past.
    if (cannotSpend(fixed(balance), fixed(required), floor)) {
      charge(
        t,
        "floor",
        computeTopupCharge(fixed(balance), fixed(target), tier.amountCents) ||
          tier.amountCents
      );
      continue;
    }

    const monthEnd = nextMonthEndSweepAt(t);
    const crossing = floorCrossingAt(fixed(balance), floor, fixed(required), fixed(burn), t);

    if (crossing !== null && crossing.getTime() <= monthEnd.getTime()) {
      if (crossing.getTime() > params.end.getTime()) break;
      balance = project(balance, burn, crossing.getTime() - t.getTime());
      t = crossing;
      // The balance sits exactly on `floor + required` at the crossing; the rule
      // fires a hair past it, which is one unit of the tier.
      const amount =
        computeTopupCharge(fixed(balance), fixed(target), tier.amountCents) ||
        tier.amountCents;
      charge(t, "floor", amount);
      continue;
    }

    if (monthEnd.getTime() > params.end.getTime()) break;
    balance = project(balance, burn, monthEnd.getTime() - t.getTime());
    t = monthEnd;
    const amount = computeSettleCharge(fixed(balance));
    if (amount > 0) charge(t, "month_end", amount);
  }

  return events;
}

export async function getChargeSchedule(
  orgId: string,
  horizonDays: number = DEFAULT_CHARGE_SCHEDULE_HORIZON_DAYS,
  now: Date = new Date()
): Promise<ChargeSchedule | null> {
  const resolved = await resolvePaymentOutlook(orgId, now);
  if (!resolved) return null;
  const { outlook, inputs } = resolved;
  const end = new Date(now.getTime() + horizonDays * DAY_MS);

  let events: ExpectedCharge[] = [];

  const replayable =
    (outlook.state === "will_charge" && outlook.trigger !== "retry_rung") ||
    outlook.state === "charge_due_now" ||
    outlook.state === "idle";

  if (replayable && inputs.tierAmountCents !== null && outlook.realizedDailyBurnCents !== null) {
    events = replayCharges({
      now,
      end,
      balanceCents: inputs.balanceCents,
      paidTopupsCents: inputs.paidTopupsCents,
      requiredCents: inputs.requiredCents,
      dailyBurnCents: outlook.realizedDailyBurnCents,
      paymentMode: outlook.paymentMode,
      dueNow: outlook.state === "charge_due_now",
    });
  } else if (
    outlook.trigger === "retry_rung" &&
    outlook.nextChargeAttemptAt !== null &&
    inputs.tierAmountCents !== null &&
    new Date(outlook.nextChargeAttemptAt).getTime() <= end.getTime()
  ) {
    // A refused card: one attempt at the next rung, the amount the reload sweep
    // would ask for. Nothing after it — a schedule built on the bank saying yes
    // would be a prediction billing cannot make.
    const tier = reloadTierFor(inputs.paidTopupsCents, outlook.paymentMode);
    const target = new Decimal(inputs.requiredCents).plus(tier.thresholdCents);
    const amount =
      computeTopupCharge(inputs.balanceCents, fixed(target), tier.amountCents) ||
      tier.amountCents;
    const before = new Decimal(inputs.balanceCents);
    events = [
      {
        at: outlook.nextChargeAttemptAt,
        trigger: "retry_rung",
        expectedAmountCents: String(amount),
        projectedBalanceBeforeCents: fixed(before),
        projectedBalanceAfterCents: fixed(before.plus(amount)),
      },
    ];
  } else if (
    outlook.state === "unknown" &&
    outlook.trigger === "month_end" &&
    outlook.nextChargeAttemptAt !== null &&
    new Date(outlook.nextChargeAttemptAt).getTime() <= end.getTime()
  ) {
    events = [
      {
        at: outlook.nextChargeAttemptAt,
        trigger: "month_end",
        expectedAmountCents: null,
        projectedBalanceBeforeCents: null,
        projectedBalanceAfterCents: null,
      },
    ];
  }

  let total: Decimal | null = new Decimal(0);
  for (const e of events) {
    if (e.expectedAmountCents === null) {
      total = null;
      break;
    }
    total = total.plus(e.expectedAmountCents);
  }

  return {
    orgId,
    paymentMode: outlook.paymentMode,
    state: outlook.state,
    blockedReason: outlook.blockedReason,
    asOf: now.toISOString(),
    horizonDays,
    horizonEndsAt: end.toISOString(),
    balanceCents: outlook.balanceCents,
    floorCents: outlook.floorCents,
    realizedDailyBurnCents: outlook.realizedDailyBurnCents,
    burnUnavailableReason: outlook.burnUnavailableReason,
    burnWindowDays: outlook.burnWindowDays,
    events,
    expectedTotalCents: total === null ? null : String(total.toNumber()),
  };
}

