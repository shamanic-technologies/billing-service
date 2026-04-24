import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { creditProvisions } from "../db/schema.js";
import { TransferBrandRequestSchema } from "../schemas.js";

const router = Router();

router.post("/internal/transfer-brand", async (req, res) => {
  const parsed = TransferBrandRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { brandId, sourceOrgId, targetOrgId } = parsed.data;

  // Update credit_provisions where org_id = sourceOrgId AND brand_ids has exactly one element AND that element is brandId
  const result = await db.execute(sql`
    UPDATE credit_provisions
    SET org_id = ${targetOrgId},
        updated_at = NOW()
    WHERE org_id = ${sourceOrgId}
      AND array_length(brand_ids, 1) = 1
      AND brand_ids[1] = ${brandId}
  `);

  const creditProvisionsCount = Number(result.count ?? 0);

  console.log(
    `[billing-service] transfer-brand: brandId=${brandId} from=${sourceOrgId} to=${targetOrgId} credit_provisions=${creditProvisionsCount}`
  );

  res.json({
    updatedTables: [
      { tableName: "credit_provisions", count: creditProvisionsCount },
    ],
  });
});

export default router;
