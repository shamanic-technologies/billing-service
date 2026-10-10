/**
 * A brand's ONE daily budget for SALES — "global" mode.
 *
 * A brand is funded one of two ways, and this module is the only place that says
 * which:
 *
 * - `campaigns` (the default, and the only mode that existed before): every
 *   campaign (offer x leg x channel) is paced on its own ceiling
 *   (lib/campaign-budgets.ts). The brand total is their sum.
 * - `global`: the brand stated ONE daily amount for sales. campaign-service decides
 *   where it goes (the best-return sales path, as features-service ranks it) and
 *   runs the reactive legs whenever the customer authorised them. The campaign
 *   ceilings are kept exactly as they were — clearing the global budget puts the
 *   brand straight back on them.
 *
 * billing only STORES + SERVES the amount and the mode; allocating it is
 * campaign-service's job. Every state and every clear is journaled
 * (`brand_sales_budget_changes`), and the BRAND TOTAL timeline
 * (`brand_daily_budget_changes`, replayed by the by-day read) gets the new
 * effective total in the same transaction, so a past day stays answerable.
 *
 * Fail-loud: any DB error propagates.
 */

import { and, asc, eq } from "drizzle-orm";
import { withRecurringFunnelCaps } from "./funnel-campaigns.js";
import { db } from "../db/index.js";
import {
  brandDailyBudgetChanges,
  brandDailyBudgets,
  brandSalesBudgetChanges,
  brandSalesBudgets,
  campaignDailyBudgets,
  type BrandSalesBudget,
  type BrandSalesBudgetChange,
} from "../db/schema.js";
import { sumCeilings } from "./campaign-budgets.js";

export type BrandBudgetMode = "global" | "campaigns";

/** The brand's funding mode and, in global mode, the stated amount. */
export interface BrandSalesBudgetView {
  mode: BrandBudgetMode;
  /** The stated daily sales budget; null in `campaigns` mode (nothing stated). */
  dailyBudgetCents: string | null;
  /** When it was stated; null in `campaigns` mode. */
  updatedAt: Date | null;
}

export function viewOf(row: BrandSalesBudget | null): BrandSalesBudgetView {
  return row
    ? { mode: "global", dailyBudgetCents: row.dailyBudgetCents, updatedAt: row.updatedAt }
    : { mode: "campaigns", dailyBudgetCents: null, updatedAt: null };
}

/** The stored global sales budget for one org+brand, or null (campaigns mode). */
export async function getBrandSalesBudget(
  orgId: string,
  brandId: string
): Promise<BrandSalesBudget | null> {
  const [row] = await db
    .select()
    .from(brandSalesBudgets)
    .where(and(eq(brandSalesBudgets.orgId, orgId), eq(brandSalesBudgets.brandId, brandId)))
    .limit(1);
  return row ?? null;
}

export interface SetBrandSalesBudgetResult {
  row: BrandSalesBudget;
  /** The amount stated before this write, or null when the brand was in campaigns mode. */
  previousDailyBudgetCents: string | null;
}

/**
 * State (or restate) the brand's global sales budget. `dailyBudgetCents` is a
 * canonical non-negative cents string (0 is legal: a brand selling nothing today).
 * The campaign ceilings are NOT touched.
 */
export async function setBrandSalesBudget(
  orgId: string,
  brandId: string,
  dailyBudgetCents: string
): Promise<SetBrandSalesBudgetResult> {
  return db.transaction(async (tx) => {
    const changedAt = new Date();
    const [existing] = await tx
      .select()
      .from(brandSalesBudgets)
      .where(and(eq(brandSalesBudgets.orgId, orgId), eq(brandSalesBudgets.brandId, brandId)))
      .limit(1)
      .for("update");

    const [row] = await tx
      .insert(brandSalesBudgets)
      .values({ orgId, brandId, dailyBudgetCents, updatedAt: changedAt })
      .onConflictDoUpdate({
        target: [brandSalesBudgets.orgId, brandSalesBudgets.brandId],
        set: { dailyBudgetCents, updatedAt: changedAt },
      })
      .returning();

    await tx.insert(brandSalesBudgetChanges).values({
      orgId,
      brandId,
      dailyBudgetCents,
      changedAt,
    });
    // The brand total is the global amount (+ recurring funnel caps) from now on.
    await tx.insert(brandDailyBudgetChanges).values({
      orgId,
      brandId,
      dailyBudgetCents: await withRecurringFunnelCaps(tx, orgId, brandId, dailyBudgetCents),
      changedAt,
    });

    return { row, previousDailyBudgetCents: existing ? existing.dailyBudgetCents : null };
  });
}

export interface ClearBrandSalesBudgetResult {
  /** false when the brand was already in campaigns mode (nothing written). */
  cleared: boolean;
  previousDailyBudgetCents: string | null;
  /** The brand total the brand is back on (its campaign ceilings), null when none. */
  campaignsDailyBudgetCents: string | null;
}

/**
 * Clear the brand's global sales budget: the brand returns to its campaign
 * ceilings. Idempotent — clearing a brand in campaigns mode writes nothing.
 */
export async function clearBrandSalesBudget(
  orgId: string,
  brandId: string
): Promise<ClearBrandSalesBudgetResult> {
  return db.transaction(async (tx) => {
    const changedAt = new Date();
    const [deleted] = await tx
      .delete(brandSalesBudgets)
      .where(and(eq(brandSalesBudgets.orgId, orgId), eq(brandSalesBudgets.brandId, brandId)))
      .returning();

    const ceilings = await tx
      .select()
      .from(campaignDailyBudgets)
      .where(and(eq(campaignDailyBudgets.orgId, orgId), eq(campaignDailyBudgets.brandId, brandId)));
    let campaignsDailyBudgetCents: string | null = null;
    if (ceilings.length > 0) {
      campaignsDailyBudgetCents = sumCeilings(ceilings);
    } else {
      const [brandRow] = await tx
        .select()
        .from(brandDailyBudgets)
        .where(and(eq(brandDailyBudgets.orgId, orgId), eq(brandDailyBudgets.brandId, brandId)))
        .limit(1);
      campaignsDailyBudgetCents = brandRow ? brandRow.dailyBudgetCents : null;
    }

    if (!deleted) {
      return { cleared: false, previousDailyBudgetCents: null, campaignsDailyBudgetCents };
    }

    await tx.insert(brandSalesBudgetChanges).values({
      orgId,
      brandId,
      dailyBudgetCents: null,
      changedAt,
    });
    // The brand total is back to what its campaigns (or brand scalar) state. A
    // brand with nothing else configured now spends nothing, recorded as 0.
    await tx.insert(brandDailyBudgetChanges).values({
      orgId,
      brandId,
      dailyBudgetCents: await withRecurringFunnelCaps(tx, orgId, brandId, campaignsDailyBudgetCents ?? "0"),
      changedAt,
    });

    return {
      cleared: true,
      previousDailyBudgetCents: deleted.dailyBudgetCents,
      campaignsDailyBudgetCents,
    };
  });
}

/** Every state / clear of the brand's global sales budget, oldest first. */
export async function getBrandSalesBudgetHistory(
  orgId: string,
  brandId: string
): Promise<BrandSalesBudgetChange[]> {
  return db
    .select()
    .from(brandSalesBudgetChanges)
    .where(
      and(eq(brandSalesBudgetChanges.orgId, orgId), eq(brandSalesBudgetChanges.brandId, brandId))
    )
    .orderBy(asc(brandSalesBudgetChanges.changedAt), asc(brandSalesBudgetChanges.id));
}
