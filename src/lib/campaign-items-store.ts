/**
 * Reads and pure arithmetic over item budgets PER CAMPAIGN (migration 0063). Kept
 * apart from lib/campaign-items (the writes, which charge cards through the
 * subscription engine) so the brand-total read and the subscription engine can use
 * it without an import cycle.
 */

import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaignItemBudgets, type CampaignItemBudget } from "../db/schema.js";
import { DAYS_PER_MONTH, type SalesPathTerms } from "./sales-path-terms.js";
import type { RecurringCampaignStatus } from "./campaign-service-client.js";

/** The smallest monthly plan a subscriber pays when it is priced from items. */
export const ITEMS_PLAN_MIN_MONTHLY_CENTS = 9900;

export async function listBrandItems(orgId: string, brandId: string): Promise<CampaignItemBudget[]> {
  return db
    .select()
    .from(campaignItemBudgets)
    .where(and(eq(campaignItemBudgets.orgId, orgId), eq(campaignItemBudgets.brandId, brandId)))
    .orderBy(
      asc(campaignItemBudgets.offerId),
      asc(campaignItemBudgets.role),
      asc(campaignItemBudgets.featureSlug),
      asc(campaignItemBudgets.legKey)
    );
}

export async function listOfferItems(
  orgId: string,
  brandId: string,
  offerId: string
): Promise<CampaignItemBudget[]> {
  return (await listBrandItems(orgId, brandId)).filter((r) => r.offerId === offerId);
}

/** Is this channel one we run today? Unknown (catalogue silent / unreadable) is NOT run. */
function runs(terms: SalesPathTerms | null, featureSlug: string): boolean | null {
  return terms ? terms.managedChannel(featureSlug) : null;
}

/**
 * The brand's daily total in items mode: proactive items of channels we run (or
 * whose status is unknown, so a catalogue outage never reads as "zero budget"),
 * a monthly item counted as its 30th. Reactive items are MAX budgets that fire on
 * leads, never daily spend, and are not added.
 */
export function itemsDailyTotalCents(rows: CampaignItemBudget[], terms: SalesPathTerms | null): string {
  let total = 0;
  for (const r of rows) {
    if (r.role !== "proactive") continue;
    if (runs(terms, r.featureSlug) === false) continue;
    total += r.period === "day" ? r.budgetCents : r.budgetCents / DAYS_PER_MONTH;
  }
  return total.toFixed(10);
}

/** Which campaigns are ON: campaign-service's status, the customer's statement of intent. */
export type CampaignOnPredicate = (
  item: Pick<CampaignItemBudget, "brandId" | "offerId" | "featureSlug" | "legKey">
) => boolean;

/** ON = a campaign of that (brand, offer, leg, channel) is `ongoing`. No campaign = off. */
export function campaignOnPredicateOf(campaigns: RecurringCampaignStatus[]): CampaignOnPredicate {
  const on = new Set(
    campaigns
      .filter((c) => c.status === "ongoing")
      .map((c) => [c.brandId, c.offerId, c.featureSlug, c.legKey].join("\u0000").toLowerCase())
  );
  return (i) => on.has([i.brandId, i.offerId, i.featureSlug, i.legKey].join("\u0000").toLowerCase());
}

export interface ItemsPlanPricing {
  /** The plan's monthly amount: SUM of the charged items, at least $99. */
  monthlyAmountCents: number;
  /** The reactive part of it. */
  reactiveMonthlyCents: number;
  /** Monthly budgets on channels we do not run yet: recorded, never charged. */
  deferredMonthlyCents: number;
  /** Monthly budgets whose campaign is OFF: kept, charged nothing. */
  offMonthlyCents: number;
}

/**
 * What one brand x offer's plan costs, from its MONTHLY item budgets. Charged =
 * a channel we run AND a campaign that is ON. Null when nothing is charged: the
 * plan keeps the amount it had.
 */
export function itemsPlanPricing(
  rows: CampaignItemBudget[],
  terms: SalesPathTerms,
  isOn: CampaignOnPredicate
): ItemsPlanPricing | null {
  let charged = 0;
  let reactive = 0;
  let deferred = 0;
  let off = 0;
  for (const r of rows) {
    if (r.period !== "month") continue;
    if (runs(terms, r.featureSlug) !== true) {
      deferred += r.budgetCents;
    } else if (!isOn(r)) {
      off += r.budgetCents;
    } else {
      charged += r.budgetCents;
      if (r.role === "reactive") reactive += r.budgetCents;
    }
  }
  if (charged === 0) return null;
  return {
    monthlyAmountCents: Math.max(ITEMS_PLAN_MIN_MONTHLY_CENTS, charged),
    reactiveMonthlyCents: reactive,
    deferredMonthlyCents: deferred,
    offMonthlyCents: off,
  };
}
