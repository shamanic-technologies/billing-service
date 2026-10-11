/**
 * How long a PREPAID org's spendable balance lasts at its current daily budgets.
 *
 * The dashboard's sidebar balance card states it ("Lasts about 12 more days"),
 * and a displayed figure is served, never divided in the browser. Nothing here is
 * a new rule: the balance is `computeBalance` (the same spendable figure every
 * spend gate reads) and the daily total is the payment outlook's RUNNING budget
 * (`resolveBudgets`: the ceilings with a campaign actually running behind them,
 * per campaign-service; a paused or stopped campaign counts 0). The ceiling is
 * configuration: no discount is ever applied to it.
 *
 * STATES, kept apart on the wire (never a number used as a sentinel):
 *  - `days`               balance > 0 and a running budget > 0: `daysLeft` + `runsOutAt`.
 *  - `depleted`           balance <= 0: spend is stopped now.
 *  - `no_budget`          nothing is running (or nothing configured): no runway to state.
 *  - `budget_unavailable` campaign-service could not be read: we do not know what runs.
 *  - `not_prepaid`        postpaid or subscription: a credit line / plan, not a runway.
 */

import { Decimal } from "decimal.js";
import { computeBalance } from "./balance.js";
import { getPaymentMode } from "./payment-mode.js";
import { resolveBudgets } from "./payment-outlook.js";
import type { PaymentMode } from "./payment-mode-types.js";

export type RunwayState = "days" | "depleted" | "no_budget" | "budget_unavailable" | "not_prepaid";

export interface Runway {
  orgId: string;
  paymentMode: PaymentMode;
  state: RunwayState;
  /** Spendable balance the runway is computed on (same as `balance_cents` on /v1/accounts). */
  balanceCents: string;
  /** Sum of the RUNNING daily budgets across the org's brands. Null when unreadable. */
  dailyBudgetCents: string | null;
  /** Configured total (running or not), informational. */
  configuredDailyBudgetCents: string;
  /** Whole days left, rounded DOWN. Null unless state is `days`. */
  daysLeft: number | null;
  /** balance / daily budget, 2 decimals. Null unless state is `days`. */
  daysLeftExact: string | null;
  /** now + balance / daily budget, ISO 8601. Null unless state is `days`. */
  runsOutAt: string | null;
}

const MS_PER_DAY = 86_400_000;

/** Pure decision, exported for tests. */
export function decideRunway(input: {
  orgId: string;
  paymentMode: PaymentMode;
  balanceCents: string;
  dailyBudgetCents: string | null;
  configuredDailyBudgetCents: string;
  now: Date;
}): Runway {
  const base = {
    orgId: input.orgId,
    paymentMode: input.paymentMode,
    balanceCents: input.balanceCents,
    dailyBudgetCents: input.dailyBudgetCents,
    configuredDailyBudgetCents: input.configuredDailyBudgetCents,
    daysLeft: null,
    daysLeftExact: null,
    runsOutAt: null,
  };
  if (input.paymentMode !== "prepaid") return { ...base, state: "not_prepaid" };
  const balance = new Decimal(input.balanceCents);
  if (balance.lte(0)) return { ...base, state: "depleted" };
  if (input.dailyBudgetCents === null) return { ...base, state: "budget_unavailable" };
  const daily = new Decimal(input.dailyBudgetCents);
  if (daily.lte(0)) return { ...base, state: "no_budget" };

  const days = balance.div(daily);
  const runsOutAt = new Date(
    input.now.getTime() + days.times(MS_PER_DAY).toDecimalPlaces(0, Decimal.ROUND_DOWN).toNumber()
  );
  return {
    ...base,
    state: "days",
    daysLeft: days.toDecimalPlaces(0, Decimal.ROUND_DOWN).toNumber(),
    daysLeftExact: days.toFixed(2, Decimal.ROUND_DOWN),
    runsOutAt: runsOutAt.toISOString(),
  };
}

/** Null when the org has no billing account. Pure read. Fail-loud on stripe/runs. */
export async function getRunway(orgId: string, now: Date = new Date()): Promise<Runway | null> {
  const paymentMode = await getPaymentMode(orgId);
  if (paymentMode === null) return null;
  if (paymentMode !== "prepaid") {
    return decideRunway({
      orgId,
      paymentMode,
      balanceCents: (await computeBalance(orgId)).balanceCents,
      dailyBudgetCents: null,
      configuredDailyBudgetCents: "0",
      now,
    });
  }
  const [snapshot, budgets] = await Promise.all([computeBalance(orgId), resolveBudgets(orgId)]);
  return decideRunway({
    orgId,
    paymentMode,
    balanceCents: snapshot.balanceCents,
    dailyBudgetCents: budgets.runningCents,
    configuredDailyBudgetCents: budgets.configuredCents,
    now,
  });
}
