/**
 * Moving a brand to another org: its HISTORY goes, its MONEY stays.
 *
 * See `POST /internal/transfer-brand` (routes/internal.ts) for the contract and
 * lib/transfer-usage.ts for how the recorded figures keep both balances unchanged.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  brandDailyBudgetChanges,
  brandDailyBudgets,
  brandSalesBudgetChanges,
  brandSalesBudgets,
  brandTransfers,
  campaignDailyBudgets,
  campaignItemBudgetChanges,
  campaignItemBudgets,
} from "../db/schema.js";
import { cmpCents } from "./cents.js";
import { fetchRunsBrandTransferMoved, runRunsBrandTransfer } from "./runs-client.js";

export interface BrandTransferRequest {
  sourceBrandId: string;
  sourceOrgId: string;
  targetOrgId: string;
  targetBrandId?: string;
}

export interface BrandTransferResult {
  updatedTables: { tableName: string; count: number }[];
  /**
   * What billing leaves on each org so neither balance moves: the spend
   * runs-service moved with the brand, still counted on the source org and not
   * counted on the target org.
   */
  balanceAdjustment: {
    transferId: string;
    movedUsageNetCents: string;
    movedActualNetCents: string;
    transferredAt: string;
  };
}

/** The target already holds a row the brand's row would become (a merge). */
export class BrandTransferConflictError extends Error {}

/** runs-service could not tell us what it moved — nothing was written. */
export class BrandTransferUpstreamError extends Error {}

export async function transferBrand(req: BrandTransferRequest): Promise<BrandTransferResult> {
  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = req;
  if (sourceOrgId === targetOrgId) {
    throw new BrandTransferConflictError("sourceOrgId and targetOrgId must differ");
  }
  const newBrandId = targetBrandId ?? sourceBrandId;

  // Refuse a merge onto rows the target already holds BEFORE asking runs-service to
  // move anything: once its cost rows have moved, billing must record them, so a
  // refusal has to come first. (The unique-violation catch below stays as the
  // backstop for a row written in between.)
  await assertNoTargetBudgetConflict(sourceOrgId, sourceBrandId, targetOrgId, newBrandId);

  // runs-service moves the brand's cost rows during the same fan-out, possibly in
  // parallel with this call. Drive its (idempotent) move to completion first, then
  // read what it moved: its ledger only answers for moves already made. Both asked
  // BEFORE any write here, so a runs-service we cannot reach leaves billing untouched.
  let moved: { usageNetCents: string; actualNetCents: string };
  try {
    await runRunsBrandTransfer({ sourceOrgId, sourceBrandId, targetOrgId, targetBrandId });
    moved = await fetchRunsBrandTransferMoved({ sourceOrgId, sourceBrandId, targetOrgId, targetBrandId });
  } catch (err) {
    throw new BrandTransferUpstreamError(
      `Failed to read the spend runs-service moved with the brand: ${(err as Error).message}`
    );
  }

  try {
    return await db.transaction(async (tx) => {
      const budgets = await tx
        .update(brandDailyBudgets)
        .set({ orgId: targetOrgId, brandId: newBrandId })
        .where(and(eq(brandDailyBudgets.orgId, sourceOrgId), eq(brandDailyBudgets.brandId, sourceBrandId)))
        .returning({ brandId: brandDailyBudgets.brandId });

      const changes = await tx
        .update(brandDailyBudgetChanges)
        .set({ orgId: targetOrgId, brandId: newBrandId })
        .where(
          and(eq(brandDailyBudgetChanges.orgId, sourceOrgId), eq(brandDailyBudgetChanges.brandId, sourceBrandId))
        )
        .returning({ id: brandDailyBudgetChanges.id });

      const ceilings = await tx
        .update(campaignDailyBudgets)
        .set({ orgId: targetOrgId, brandId: newBrandId })
        .where(and(eq(campaignDailyBudgets.orgId, sourceOrgId), eq(campaignDailyBudgets.brandId, sourceBrandId)))
        .returning({ brandId: campaignDailyBudgets.brandId });

      const salesBudgets = await tx
        .update(brandSalesBudgets)
        .set({ orgId: targetOrgId, brandId: newBrandId })
        .where(and(eq(brandSalesBudgets.orgId, sourceOrgId), eq(brandSalesBudgets.brandId, sourceBrandId)))
        .returning({ brandId: brandSalesBudgets.brandId });

      const salesChanges = await tx
        .update(brandSalesBudgetChanges)
        .set({ orgId: targetOrgId, brandId: newBrandId })
        .where(
          and(eq(brandSalesBudgetChanges.orgId, sourceOrgId), eq(brandSalesBudgetChanges.brandId, sourceBrandId))
        )
        .returning({ id: brandSalesBudgetChanges.id });

      // Campaign item budgets (migration 0063) are the brand's pacing config too.
      const items = await tx
        .update(campaignItemBudgets)
        .set({ orgId: targetOrgId, brandId: newBrandId })
        .where(and(eq(campaignItemBudgets.orgId, sourceOrgId), eq(campaignItemBudgets.brandId, sourceBrandId)))
        .returning({ id: campaignItemBudgets.id });
      const itemChanges = await tx
        .update(campaignItemBudgetChanges)
        .set({ orgId: targetOrgId, brandId: newBrandId })
        .where(
          and(eq(campaignItemBudgetChanges.orgId, sourceOrgId), eq(campaignItemBudgetChanges.brandId, sourceBrandId))
        )
        .returning({ id: campaignItemBudgetChanges.id });

      const [existing] = await tx
        .select()
        .from(brandTransfers)
        .where(
          and(
            eq(brandTransfers.sourceOrgId, sourceOrgId),
            eq(brandTransfers.sourceBrandId, sourceBrandId),
            eq(brandTransfers.targetOrgId, targetOrgId)
          )
        )
        .for("update")
        .limit(1);

      let ledgerCount = 0;
      let row = existing;
      if (!existing) {
        [row] = await tx
          .insert(brandTransfers)
          .values({
            sourceOrgId,
            sourceBrandId,
            targetOrgId,
            targetBrandId: targetBrandId ?? null,
            movedUsageNetCents: moved.usageNetCents,
            movedActualNetCents: moved.actualNetCents,
          })
          .returning();
        ledgerCount = 1;
      } else if (
        cmpCents(existing.movedUsageNetCents, moved.usageNetCents) !== 0 ||
        cmpCents(existing.movedActualNetCents, moved.actualNetCents) !== 0
      ) {
        // runs-service's answer is cumulative: a re-run that moved more (spend
        // made under the source org between two runs) raises it, one that moved
        // nothing leaves it where it was.
        [row] = await tx
          .update(brandTransfers)
          .set({
            movedUsageNetCents: moved.usageNetCents,
            movedActualNetCents: moved.actualNetCents,
            updatedAt: sql`now()`,
          })
          .where(eq(brandTransfers.id, existing.id))
          .returning();
        ledgerCount = 1;
      }

      console.log(
        `[billing-service] transfer-brand: brand=${sourceBrandId}->${newBrandId} org=${sourceOrgId}->${targetOrgId} ` +
          `brand_daily_budgets=${budgets.length} brand_daily_budget_changes=${changes.length} campaign_daily_budgets=${ceilings.length} ` +
          `moved_usage_net=${row.movedUsageNetCents} moved_actual_net=${row.movedActualNetCents} ledger_written=${ledgerCount}`
      );

      return {
        updatedTables: [
          { tableName: "brand_daily_budgets", count: budgets.length },
          { tableName: "brand_daily_budget_changes", count: changes.length },
          { tableName: "campaign_daily_budgets", count: ceilings.length },
          { tableName: "brand_sales_budgets", count: salesBudgets.length },
          { tableName: "brand_sales_budget_changes", count: salesChanges.length },
          { tableName: "campaign_item_budgets", count: items.length },
          { tableName: "campaign_item_budget_changes", count: itemChanges.length },
          { tableName: "brand_transfers", count: ledgerCount },
        ],
        balanceAdjustment: {
          transferId: row.id,
          movedUsageNetCents: row.movedUsageNetCents,
          movedActualNetCents: row.movedActualNetCents,
          transferredAt: row.transferredAt.toISOString(),
        },
      };
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new BrandTransferConflictError(
        `The target org already holds a daily budget or ceiling for brand ${newBrandId}; nothing was moved`
      );
    }
    throw err;
  }
}

async function assertNoTargetBudgetConflict(
  sourceOrgId: string,
  sourceBrandId: string,
  targetOrgId: string,
  newBrandId: string
): Promise<void> {
  const [row] = (await db.execute(sql`
    SELECT
      (EXISTS (SELECT 1 FROM brand_daily_budgets WHERE org_id = ${sourceOrgId} AND brand_id = ${sourceBrandId})
       OR EXISTS (SELECT 1 FROM campaign_daily_budgets WHERE org_id = ${sourceOrgId} AND brand_id = ${sourceBrandId})
       OR EXISTS (SELECT 1 FROM brand_sales_budgets WHERE org_id = ${sourceOrgId} AND brand_id = ${sourceBrandId})
       OR EXISTS (SELECT 1 FROM campaign_item_budgets WHERE org_id = ${sourceOrgId} AND brand_id = ${sourceBrandId}))
      AS source_has,
      (EXISTS (SELECT 1 FROM brand_daily_budgets WHERE org_id = ${targetOrgId} AND brand_id = ${newBrandId})
       OR EXISTS (SELECT 1 FROM campaign_daily_budgets WHERE org_id = ${targetOrgId} AND brand_id = ${newBrandId})
       OR EXISTS (SELECT 1 FROM brand_sales_budgets WHERE org_id = ${targetOrgId} AND brand_id = ${newBrandId})
       OR EXISTS (SELECT 1 FROM campaign_item_budgets WHERE org_id = ${targetOrgId} AND brand_id = ${newBrandId}))
      AS target_has
  `)) as unknown as { source_has: boolean; target_has: boolean }[];
  if (row.source_has && row.target_has) {
    throw new BrandTransferConflictError(
      `The target org already holds a daily budget or ceiling for brand ${newBrandId}; nothing was moved`
    );
  }
}
