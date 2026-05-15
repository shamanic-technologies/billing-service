import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { TransferBrandRequestSchema } from "../schemas.js";
import { transferBrand as ssTransferBrand } from "../lib/stripe-service-client.js";

const router = Router();

// POST /internal/transfer-brand — re-assigns solo-brand rows between orgs.
//
// Touches BOTH sides of the split:
//   - billing-local `local_promos` (per-org promo credits) — UPDATE here
//   - stripe-service ledger (payments, refunds) — proxy call
router.post("/internal/transfer-brand", async (req, res) => {
  const parsed = TransferBrandRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;

  const localStep1 = await db.execute(sql`
    UPDATE local_promos
    SET org_id = ${targetOrgId}
    WHERE org_id = ${sourceOrgId}
      AND array_length(brand_ids, 1) = 1
      AND brand_ids[1] = ${sourceBrandId}
  `);
  let localCount = Number(localStep1.count ?? 0);

  if (targetBrandId) {
    const localStep2 = await db.execute(sql`
      UPDATE local_promos
      SET brand_ids = ARRAY[${targetBrandId}]
      WHERE array_length(brand_ids, 1) = 1
        AND brand_ids[1] = ${sourceBrandId}
    `);
    localCount = Math.max(localCount, Number(localStep2.count ?? 0));
  }

  let ssCount = 0;
  try {
    const ssResult = await ssTransferBrand(
      { "x-org-id": sourceOrgId, "x-user-id": "00000000-0000-0000-0000-000000000000" },
      { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId }
    );
    ssCount = ssResult.count;
  } catch (err) {
    console.error("[billing-service] stripe-service transferBrand failed:", err);
    res.status(502).json({ error: "Failed to transfer brand in stripe-service" });
    return;
  }

  console.log(
    `[billing-service] transfer-brand: sourceBrandId=${sourceBrandId} targetBrandId=${targetBrandId ?? "none"} from=${sourceOrgId} to=${targetOrgId} local_promos=${localCount} stripe_service_rows=${ssCount}`
  );

  res.json({
    updatedTables: [
      { tableName: "local_promos", count: localCount },
      { tableName: "stripe_service_transactions", count: ssCount },
    ],
  });
});

export default router;
