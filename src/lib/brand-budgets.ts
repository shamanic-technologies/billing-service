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

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { brandDailyBudgets, type BrandDailyBudget } from "../db/schema.js";

/**
 * Set / update a brand's daily budget for one org. `dailyBudgetCents` is a
 * canonical fixed-scale cents string.
 */
export async function upsertBrandDailyBudget(
  orgId: string,
  brandId: string,
  dailyBudgetCents: string
): Promise<BrandDailyBudget> {
  const [row] = await db
    .insert(brandDailyBudgets)
    .values({
      brandId,
      orgId,
      dailyBudgetCents,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [brandDailyBudgets.orgId, brandDailyBudgets.brandId],
      set: {
        dailyBudgetCents,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
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
