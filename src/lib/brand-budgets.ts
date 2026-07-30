/**
 * Org-scoped per-brand daily-budget store.
 *
 * ONE mutable scalar per (org_id, brand_id), upserted in place. This is an
 * allocation / pacing ceiling, NOT the org credit balance/affordability — see
 * the table comment in db/schema.ts. billing-service only stores + serves this
 * value; consumers read it with org identity and enforce the cap.
 *
 * Fail-loud: any DB error propagates (no swallow).
 */

import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  brandDailyBudgets,
  brandDailyBudgetChanges,
  type BrandDailyBudget,
  type BrandDailyBudgetChange,
} from "../db/schema.js";

export interface UpsertBrandDailyBudgetResult {
  row: BrandDailyBudget;
  /**
   * The value stored for this org+brand BEFORE this write, read inside the same
   * transaction (row-locked) so a concurrent write cannot make it wrong. null
   * when this org+brand had no budget at all (a first-ever set).
   */
  previousDailyBudgetCents: string | null;
}

/**
 * Set / update a brand's daily budget for one org. `dailyBudgetCents` is a
 * canonical fixed-scale cents string.
 *
 * The current-value row (brand_daily_budgets) is upserted in place AND an
 * append-only history row (brand_daily_budget_changes) is inserted, both in ONE
 * transaction — so a budget change is never stored without its dated history
 * entry (the health-board timeline can never diverge from the current value).
 *
 * The pre-write value is SELECTed FOR UPDATE in that same transaction and
 * returned, so the staff notification's "from" side can never be a stale read
 * of a value another request has since changed. (A first-ever set has no row to
 * lock, so two concurrent first-ever writes for the same org+brand would both
 * report "unset"; the upsert still resolves the stored value correctly, and at
 * ~one write every four days fleet-wide that race is not worth a table lock.)
 */
export async function upsertBrandDailyBudget(
  orgId: string,
  brandId: string,
  dailyBudgetCents: string
): Promise<UpsertBrandDailyBudgetResult> {
  return db.transaction(async (tx) => {
    const changedAt = new Date();

    const [existing] = await tx
      .select()
      .from(brandDailyBudgets)
      .where(
        and(
          eq(brandDailyBudgets.orgId, orgId),
          eq(brandDailyBudgets.brandId, brandId)
        )
      )
      .limit(1)
      .for("update");

    const [row] = await tx
      .insert(brandDailyBudgets)
      .values({
        brandId,
        orgId,
        dailyBudgetCents,
        updatedAt: changedAt,
      })
      .onConflictDoUpdate({
        target: [brandDailyBudgets.orgId, brandDailyBudgets.brandId],
        set: {
          dailyBudgetCents,
          updatedAt: changedAt,
        },
      })
      .returning();

    await tx.insert(brandDailyBudgetChanges).values({
      orgId,
      brandId,
      dailyBudgetCents,
      changedAt,
    });

    return {
      row,
      previousDailyBudgetCents: existing ? existing.dailyBudgetCents : null,
    };
  });
}

/**
 * Read one org's ordered daily-budget change history for a brand, oldest first
 * (chronological timeline). Empty array when no budget has ever been set for
 * that org+brand.
 */
export async function getBrandDailyBudgetHistory(
  orgId: string,
  brandId: string
): Promise<BrandDailyBudgetChange[]> {
  return db
    .select()
    .from(brandDailyBudgetChanges)
    .where(
      and(
        eq(brandDailyBudgetChanges.orgId, orgId),
        eq(brandDailyBudgetChanges.brandId, brandId)
      )
    )
    .orderBy(
      asc(brandDailyBudgetChanges.changedAt),
      asc(brandDailyBudgetChanges.id)
    );
}

/** Read one org's stored daily budget for a brand, or null if none set. */
export async function getBrandDailyBudget(
  orgId: string,
  brandId: string
): Promise<BrandDailyBudget | null> {
  const [row] = await db
    .select()
    .from(brandDailyBudgets)
    .where(
      and(
        eq(brandDailyBudgets.orgId, orgId),
        eq(brandDailyBudgets.brandId, brandId)
      )
    )
    .limit(1);
  return row ?? null;
}
