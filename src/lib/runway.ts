/**
 * How long a PREPAID org's spendable balance lasts at what it REALLY spends a day.
 *
 * The dashboard's sidebar balance card states it ("Lasts about 12 more days"),
 * and a displayed figure is served, never divided in the browser. Nothing here is
 * a new rule: the balance is `computeBalance` (the same spendable figure every
 * spend gate reads), whether anything runs is the payment outlook's RUNNING
 * budget (`resolveBudgets`: a paused or stopped campaign counts 0), and the
 * divisor is the payment outlook's MEASURED campaign spend per day
 * (`fetchRealizedDailyBurn`).
 *
 * The divisor is NEVER the budget (RUNWAY-REAL-SPEND-1126). A budget is a
 * ceiling: WriteBros (2026-11-26, $94.65 balance) had a $121/day max budget and
 * spent $4.62 that day, and the card read "Runs out today" on its first visit.
 * The payment outlook made the same call for the same reason (utilisation ran
 * 4% to 146% of the ceiling).
 *
 * STATES, kept apart on the wire (never a number used as a sentinel). The set is
 * CLOSED: the dashboard parses it with a strict enum, so a new case rides an
 * existing "no figure" state and names itself in `noFigureReason`:
 *  - `days`               balance > 0, a budget running, spend measured > 0: `daysLeft` + `runsOutAt`.
 *  - `depleted`           balance <= 0: spend is stopped now.
 *  - `no_budget`          nothing is running (or nothing configured), or something runs
 *                         but nothing was spent in the window (`noFigureReason: "no_spend"`).
 *  - `budget_unavailable` campaign-service could not be read, or the spend per day cannot be
 *                         measured honestly (`noFigureReason: "burn_unavailable"`).
 *  - `not_prepaid`        postpaid or subscription: a credit line / plan, not a runway.
 */

import { Decimal } from "decimal.js";
import { computeBalance } from "./balance.js";
import { getPaymentMode } from "./payment-mode.js";
import { resolveBudgets } from "./payment-outlook.js";
import { snapshotSpendableBudgetReader } from "./spendable-budget-snapshots.js";
import { fetchRealizedDailyBurn, type RealizedBurn } from "./realized-burn.js";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { PaymentMode } from "./payment-mode-types.js";

export type RunwayState = "days" | "depleted" | "no_budget" | "budget_unavailable" | "not_prepaid";

/** Why a running org gets no figure, beyond what `state` says. Null otherwise. */
export type RunwayNoFigureReason = "no_spend" | "burn_unavailable";

export interface Runway {
  orgId: string;
  paymentMode: PaymentMode;
  state: RunwayState;
  noFigureReason: RunwayNoFigureReason | null;
  /** Spendable balance the runway is computed on (same as `balance_cents` on /v1/accounts). */
  balanceCents: string;
  /** Sum of the RUNNING daily budgets across the org's brands. Null when unreadable. */
  dailyBudgetCents: string | null;
  /** Configured total (running or not), informational. */
  configuredDailyBudgetCents: string;
  /** Measured campaign spend per day: the runway's divisor. Null when not measured. */
  dailySpendCents: string | null;
  /** Whole days left, rounded DOWN. Null unless state is `days`. */
  daysLeft: number | null;
  /** balance / daily spend, 2 decimals. Null unless state is `days`. */
  daysLeftExact: string | null;
  /** now + balance / daily spend, ISO 8601. Null unless state is `days`. */
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
  /** Measured spend per day; null = could not be measured (only read when a budget runs). */
  dailySpendCents: string | null;
  now: Date;
}): Runway {
  const base = {
    orgId: input.orgId,
    paymentMode: input.paymentMode,
    balanceCents: input.balanceCents,
    dailyBudgetCents: input.dailyBudgetCents,
    configuredDailyBudgetCents: input.configuredDailyBudgetCents,
    dailySpendCents: input.dailySpendCents,
    noFigureReason: null,
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
  if (input.dailySpendCents === null) {
    return { ...base, state: "budget_unavailable", noFigureReason: "burn_unavailable" };
  }
  const spend = new Decimal(input.dailySpendCents);
  if (spend.lte(0)) return { ...base, state: "no_budget", noFigureReason: "no_spend" };

  const days = balance.div(spend);
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
  // Latency (MON-PAGE-SPEED-1111): this read sits on every dashboard page, so the
  // balance (stripe-service + runs-service) starts with the payment-mode read
  // instead of behind it, and campaign-service's per-brand answer comes from the
  // snapshot reader (lib/spendable-budget-snapshots): served from the last read,
  // refreshed behind it, never once billing's own budget rows changed.
  const balanceP = computeBalance(orgId);
  // Not awaited when the org has no account: keep that rejection off the process.
  balanceP.catch(() => undefined);
  const paymentMode = await getPaymentMode(orgId);
  if (paymentMode === null) return null;
  if (paymentMode !== "prepaid") {
    return decideRunway({
      orgId,
      paymentMode,
      balanceCents: (await balanceP).balanceCents,
      dailyBudgetCents: null,
      configuredDailyBudgetCents: "0",
      dailySpendCents: null,
      now,
    });
  }
  const [snapshot, budgets, burn] = await Promise.all([
    balanceP,
    resolveBudgets(orgId, snapshotSpendableBudgetReader()),
    cachedDailyBurn(orgId, now),
  ]);
  return decideRunway({
    orgId,
    paymentMode,
    balanceCents: snapshot.balanceCents,
    dailyBudgetCents: budgets.runningCents,
    configuredDailyBudgetCents: budgets.configuredCents,
    dailySpendCents: burn.dailyCents,
    now,
  });
}

/**
 * The measured spend per day, held 10 minutes per org. This read sits on every
 * dashboard page and runs-service's dated read is the slow one (cold reads
 * measured at ~9 s), while a spend averaged over up to 14 days barely moves in
 * 10 minutes. One read in flight per org; a failure is never cached and throws
 * (the route answers 502, never a runway on a guessed spend).
 */
export const RUNWAY_BURN_TTL_MS = 10 * 60_000;
const burnCache = new Map<string, { at: number; value: Promise<RealizedBurn> }>();

async function cachedDailyBurn(orgId: string, now: Date): Promise<RealizedBurn> {
  const hit = burnCache.get(orgId);
  if (hit && now.getTime() - hit.at < RUNWAY_BURN_TTL_MS) return hit.value;
  const value = (async () => {
    const [account] = await db
      .select({ createdAt: billingAccounts.createdAt })
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);
    return fetchRealizedDailyBurn(orgId, now, account?.createdAt ?? null);
  })();
  burnCache.set(orgId, { at: now.getTime(), value });
  value.catch(() => {
    if (burnCache.get(orgId)?.value === value) burnCache.delete(orgId);
  });
  return value;
}

/** Test-only: forget every held spend figure. */
export function __clearRunwayBurnCache(): void {
  burnCache.clear();
}
