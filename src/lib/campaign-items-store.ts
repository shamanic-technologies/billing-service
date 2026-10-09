/**
 * A campaign's budget as the "you choose, we run" model reads it (migration 0064):
 * ONE store per campaign, the ceiling row (campaign_daily_budgets). A row carrying
 * `monthly_budget_cents` is a subscriber's MONTHLY budget (its daily ceiling being
 * monthly / 30); any other row is a DAILY budget. Pure reads and arithmetic, kept
 * apart from lib/campaign-items (the writes, which charge cards through the
 * subscription engine) so the subscription engine can use it without a cycle.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaignDailyBudgets, type CeilingRow } from "../db/schema.js";
import type { SalesPathTerms } from "./sales-path-terms.js";
import type { RecurringCampaignStatus } from "./campaign-service-client.js";
import { canonicalLegKey } from "./leg-identity.js";

/** The smallest monthly plan a subscriber pays when it is priced from campaign budgets. */
export const ITEMS_PLAN_MIN_MONTHLY_CENTS = 9900;

export type ItemPeriod = "day" | "month";
export type ItemRoleServed = "proactive" | "reactive";

/** One campaign's budget, read off its ceiling row. */
export interface CampaignItem {
  brandId: string;
  offerId: string;
  featureSlug: string;
  legKey: string;
  period: ItemPeriod;
  /** In the item's period: monthly cents (whole) or daily cents (may be fractional). */
  budgetCents: number;
  /** The daily ceiling as stored (decimal string). */
  dailyBudgetCents: string;
  /** The part of the daily ceiling sourcing may spend, on demand (lib/campaign-sourcing); null = not split. */
  sourcingCeilingCents: string | null;
  /**
   * A subscriber's budget DERIVED FROM ITS PLAN (lib/subscriber-plan-budgets), not
   * stated by the customer: it IS the plan, so it never prices it and is never
   * charged on top of it.
   */
  planDerived: boolean;
  updatedAt: Date;
}

/** A ceiling row as a campaign item; null for a legacy row not scoped to an offer and a leg. */
export function itemOf(row: CeilingRow): CampaignItem | null {
  if (!row.offerId || !row.legKey) return null;
  const month = row.monthlyBudgetCents !== null && row.monthlyBudgetCents !== undefined;
  return {
    brandId: row.brandId,
    offerId: row.offerId,
    featureSlug: row.featureSlug,
    legKey: row.legKey,
    period: month ? "month" : "day",
    budgetCents: month ? (row.monthlyBudgetCents as number) : Number(row.dailyBudgetCents),
    dailyBudgetCents: row.dailyBudgetCents,
    sourcingCeilingCents: row.sourcingCeilingCents ?? null,
    planDerived: row.planDerived === true,
    updatedAt: row.updatedAt,
  };
}

export async function listBrandCeilingRows(orgId: string, brandId: string): Promise<CeilingRow[]> {
  return db
    .select()
    .from(campaignDailyBudgets)
    .where(and(eq(campaignDailyBudgets.orgId, orgId), eq(campaignDailyBudgets.brandId, brandId)));
}

export async function listOfferItems(orgId: string, brandId: string, offerId: string): Promise<CampaignItem[]> {
  return (await listBrandCeilingRows(orgId, brandId))
    .map(itemOf)
    .filter((i): i is CampaignItem => i !== null && i.offerId === offerId);
}

/** Does the brand hold a subscriber's monthly campaign budget (→ "items" mode)? */
export function holdsMonthlyBudget(rows: CeilingRow[]): boolean {
  return rows.some((r) => r.monthlyBudgetCents !== null && r.monthlyBudgetCents !== undefined);
}

/** Which campaigns are ON: campaign-service's status, the customer's statement of intent. */
export type CampaignOnPredicate = (item: Pick<CampaignItem, "brandId" | "offerId" | "featureSlug" | "legKey">) => boolean;

/** ON = a campaign of that (brand, offer, leg, channel) is `ongoing`. No campaign = off. */
export function campaignOnPredicateOf(campaigns: RecurringCampaignStatus[]): CampaignOnPredicate {
  const on = new Set(
    campaigns
      .filter((c) => c.status === "ongoing")
      .map((c) => [c.brandId, c.offerId, c.featureSlug, canonicalLegKey(c.featureSlug, c.legKey)].join("\u0000").toLowerCase())
  );
  // Either spelling of an outbound leg is the same campaign (lib/leg-identity).
  return (i) =>
    on.has([i.brandId, i.offerId, i.featureSlug, canonicalLegKey(i.featureSlug, i.legKey)].join("\u0000").toLowerCase());
}

/** The item's role from the published terms; null when the catalogue does not carry it. */
export function roleOf(terms: SalesPathTerms | null, featureSlug: string, legKey: string): ItemRoleServed | null {
  const t = terms?.termsFor(featureSlug, legKey);
  return t && t.role !== "customer" ? t.role : null;
}

export interface ItemsPlanPricing {
  /** The plan's monthly amount: SUM of the charged budgets, at least $99. */
  monthlyAmountCents: number;
  /** The reactive part of it. */
  reactiveMonthlyCents: number;
  /** Monthly budgets on channels we do not run yet: recorded, never charged. */
  deferredMonthlyCents: number;
  /** Monthly budgets whose campaign is OFF: kept, charged nothing. */
  offMonthlyCents: number;
}

/**
 * What one brand x offer's plan costs, from its MONTHLY campaign budgets. Charged =
 * a channel we run AND a campaign that is ON. A budget DERIVED FROM THE PLAN is the
 * plan itself, never a reason to change it: skipped. Null when nothing is charged:
 * the plan keeps the amount it had.
 */
export function itemsPlanPricing(
  items: CampaignItem[],
  terms: SalesPathTerms,
  isOn: CampaignOnPredicate
): ItemsPlanPricing | null {
  let charged = 0;
  let reactive = 0;
  let deferred = 0;
  let off = 0;
  for (const i of items) {
    if (i.period !== "month" || i.planDerived) continue;
    if (terms.managedChannel(i.featureSlug) !== true) {
      deferred += i.budgetCents;
    } else if (!isOn(i)) {
      off += i.budgetCents;
    } else {
      charged += i.budgetCents;
      if (roleOf(terms, i.featureSlug, i.legKey) === "reactive") reactive += i.budgetCents;
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
