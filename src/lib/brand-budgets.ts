/**
 * Per-brand daily-budget store — the brand's current daily spend ceiling.
 *
 * ONE mutable scalar per brand (PK = brand_id), upserted in place. This is an
 * allocation / pacing ceiling, NOT the org credit balance/affordability — see
 * the table comment in db/schema.ts. billing-service only stores + serves this
 * value; campaign-service reads it and enforces the cap.
 *
 * Fail-loud: any DB error propagates (no swallow).
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { brandDailyBudgets, type BrandDailyBudget } from "../db/schema.js";

/**
 * Set / update a brand's daily budget. One row per brand (PK), upserted in
 * place. `dailyBudgetCents` is a canonical fixed-scale cents string.
 */
export async function upsertBrandDailyBudget(
  brandId: string,
  orgId: string,
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
      target: brandDailyBudgets.brandId,
      set: {
        orgId,
        dailyBudgetCents,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

/** Read a brand's stored daily budget, or null if none set. */
export async function getBrandDailyBudget(
  brandId: string
): Promise<BrandDailyBudget | null> {
  const [row] = await db
    .select()
    .from(brandDailyBudgets)
    .where(eq(brandDailyBudgets.brandId, brandId))
    .limit(1);
  return row ?? null;
}
