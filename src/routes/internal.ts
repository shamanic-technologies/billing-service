import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { TransferBrandRequestSchema } from "../schemas.js";

const router = Router();

router.post("/internal/transfer-brand", async (req, res) => {
  const parsed = TransferBrandRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;

  // When targetBrandId is present, rewrite the brand reference too (conflict case)
  const newBrandId = targetBrandId ?? sourceBrandId;

  const result = await db.execute(sql`
    UPDATE credit_provisions
    SET org_id = ${targetOrgId},
        brand_ids = ARRAY[${newBrandId}],
        updated_at = NOW()
    WHERE org_id = ${sourceOrgId}
      AND array_length(brand_ids, 1) = 1
      AND brand_ids[1] = ${sourceBrandId}
  `);

  const creditProvisionsCount = Number(result.count ?? 0);

  console.log(
    `[billing-service] transfer-brand: sourceBrandId=${sourceBrandId} targetBrandId=${targetBrandId ?? "none"} from=${sourceOrgId} to=${targetOrgId} credit_provisions=${creditProvisionsCount}`
  );

  res.json({
    updatedTables: [
      { tableName: "credit_provisions", count: creditProvisionsCount },
    ],
  });
});

export default router;
