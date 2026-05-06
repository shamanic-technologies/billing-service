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

  // Step 1: Move org_id from sourceOrgId to targetOrgId for solo-brand rows
  const step1 = await db.execute(sql`
    UPDATE transactions
    SET org_id = ${targetOrgId},
        updated_at = NOW()
    WHERE org_id = ${sourceOrgId}
      AND array_length(brand_ids, 1) = 1
      AND brand_ids[1] = ${sourceBrandId}
  `);

  let transactionsCount = Number(step1.count ?? 0);

  // Step 2: Rewrite brand reference when targetBrandId is provided (conflict case)
  if (targetBrandId) {
    const step2 = await db.execute(sql`
      UPDATE transactions
      SET brand_ids = ARRAY[${targetBrandId}],
          updated_at = NOW()
      WHERE array_length(brand_ids, 1) = 1
        AND brand_ids[1] = ${sourceBrandId}
    `);
    transactionsCount = Math.max(transactionsCount, Number(step2.count ?? 0));
  }

  console.log(
    `[billing-service] transfer-brand: sourceBrandId=${sourceBrandId} targetBrandId=${targetBrandId ?? "none"} from=${sourceOrgId} to=${targetOrgId} transactions=${transactionsCount}`
  );

  res.json({
    updatedTables: [
      { tableName: "transactions", count: transactionsCount },
    ],
  });
});

export default router;
