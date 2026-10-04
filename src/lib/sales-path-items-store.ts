/**
 * Reads and pure arithmetic over sales-path ITEM budgets (migration 0062). Kept
 * apart from lib/sales-path-items (the writes, which charge cards through the
 * subscription engine) so the brand-total read and the subscription engine can
 * use it without an import cycle.
 */

import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { salesPathItemBudgets, type SalesPathItemBudget } from "../db/schema.js";
import { DAYS_PER_MONTH, type SalesPathTerms } from "./sales-path-terms.js";

/** The smallest monthly plan a subscriber pays when it is priced from items. */
export const ITEMS_PLAN_MIN_MONTHLY_CENTS = 9900;

export async function listBrandItems(orgId: string, brandId: string): Promise<SalesPathItemBudget[]> {
  return db
    .select()
    .from(salesPathItemBudgets)
    .where(and(eq(salesPathItemBudgets.orgId, orgId), eq(salesPathItemBudgets.brandId, brandId)))
    .orderBy(
      asc(salesPathItemBudgets.offerId),
      asc(salesPathItemBudgets.pathKey),
      asc(salesPathItemBudgets.role),
      asc(salesPathItemBudgets.featureSlug),
      asc(salesPathItemBudgets.legKey)
    );
}

export async function listOfferItems(
  orgId: string,
  brandId: string,
  offerId: string
): Promise<SalesPathItemBudget[]> {
  return (await listBrandItems(orgId, brandId)).filter((r) => r.offerId === offerId);
}

/** Is this channel one we run today? Unknown (catalogue silent / unreadable) is NOT run. */
function runs(terms: SalesPathTerms | null, featureSlug: string): boolean | null {
  return terms ? terms.managedChannel(featureSlug) : null;
}

/**
 * The brand's daily total in items mode: proactive items of channels we run (or
 * whose status is unknown, so a catalogue outage never reads as "zero budget"),
 * a monthly item counted as its 30th. Reactive items fire on leads, not daily,
 * and are never added (same rule as the budget-change email's reactive caps).
 */
export function itemsDailyTotalCents(rows: SalesPathItemBudget[], terms: SalesPathTerms | null): string {
  let total = 0;
  for (const r of rows) {
    if (r.role !== "proactive") continue;
    if (runs(terms, r.featureSlug) === false) continue;
    total += r.period === "day" ? r.budgetCents : r.budgetCents / DAYS_PER_MONTH;
  }
  return total.toFixed(10);
}

export interface ItemsPlanPricing {
  /** The plan's monthly amount: SUM of the charged items, at least $99. */
  monthlyAmountCents: number;
  /** The reactive part of it. */
  reactiveMonthlyCents: number;
  /** Monthly commitments on channels we do not run yet: recorded, never charged. */
  deferredMonthlyCents: number;
}

/**
 * What one brand x offer's plan costs, from its MONTHLY item budgets. Only items
 * on channels we run are charged; a channel we do not run (or whose status the
 * catalogue does not state) is a deferred commitment. Null when no item is
 * charged: the plan keeps the amount it had (a brand with only deferred items,
 * or none, pays exactly what it paid before).
 */
export function itemsPlanPricing(
  rows: SalesPathItemBudget[],
  terms: SalesPathTerms
): ItemsPlanPricing | null {
  let charged = 0;
  let reactive = 0;
  let deferred = 0;
  for (const r of rows) {
    if (r.period !== "month") continue;
    if (runs(terms, r.featureSlug) === true) {
      charged += r.budgetCents;
      if (r.role === "reactive") reactive += r.budgetCents;
    } else {
      deferred += r.budgetCents;
    }
  }
  if (charged === 0) return null;
  return {
    monthlyAmountCents: Math.max(ITEMS_PLAN_MIN_MONTHLY_CENTS, charged),
    reactiveMonthlyCents: reactive,
    deferredMonthlyCents: deferred,
  };
}

/** One item as campaign-service spends it: (offer, leg, channel), summed across paths. */
export interface SpendableItem {
  offerId: string;
  legKey: string;
  featureSlug: string;
  role: "proactive" | "reactive";
  period: "day" | "month";
  budgetCents: number;
  pathKeys: string[];
}

export function spendableItemsOf(rows: SalesPathItemBudget[]): SpendableItem[] {
  const byKey = new Map<string, SpendableItem>();
  for (const r of rows) {
    const k = [r.offerId, r.legKey, r.featureSlug, r.period].join("\u0000");
    const hit = byKey.get(k);
    if (hit) {
      hit.budgetCents += r.budgetCents;
      if (!hit.pathKeys.includes(r.pathKey)) hit.pathKeys.push(r.pathKey);
      continue;
    }
    byKey.set(k, {
      offerId: r.offerId,
      legKey: r.legKey,
      featureSlug: r.featureSlug,
      role: r.role as "proactive" | "reactive",
      period: r.period as "day" | "month",
      budgetCents: r.budgetCents,
      pathKeys: [r.pathKey],
    });
  }
  return [...byKey.values()];
}
