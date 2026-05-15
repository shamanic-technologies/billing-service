import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { localPromos, localPromoCodes } from "../../src/db/schema.js";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, insertTestPromoCode, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

describe("POST /internal/transfer-brand", () => {
  const app = createTestApp();
  const sourceOrgId = "00000000-0000-0000-0000-000000000001";
  const targetOrgId = "00000000-0000-0000-0000-000000000002";
  const sourceBrandId = "00000000-0000-0000-0000-00000000b001";
  const targetBrandId = "00000000-0000-0000-0000-00000000b003";
  const otherBrandId = "00000000-0000-0000-0000-00000000b002";
  const userId = "00000000-0000-0000-0000-000000000099";

  const internalHeaders = {
    "X-API-Key": "test-api-key",
    "Content-Type": "application/json",
  };

  let ssMocks: ReturnType<typeof setupStripeMocks>;

  async function insertPromoGrantWithBrand(brandIds: string[] | null) {
    await insertTestPromoCode({ code: `p-${Math.random()}`, amountCents: 100 });
    const [codeRow] = await db.select().from(localPromoCodes).limit(1);
    const [row] = await db
      .insert(localPromos)
      .values({
        orgId: sourceOrgId,
        userId,
        amountCents: "100",
        promoCodeId: codeRow.id,
        description: "test",
        brandIds,
      })
      .returning();
    return row;
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
    await insertTestAccount({ orgId: sourceOrgId });
    await insertTestAccount({ orgId: targetOrgId });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("transfers solo-brand local_promos rows from source to target org and calls SS", async () => {
    ssMocks.transferBrand.mockResolvedValue({ count: 5 });
    await insertPromoGrantWithBrand([sourceBrandId]);

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "local_promos", count: 1 },
      { tableName: "stripe_service_transactions", count: 5 },
    ]);
    expect(ssMocks.transferBrand).toHaveBeenCalledWith(
      expect.objectContaining({ "x-org-id": sourceOrgId }),
      { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId: undefined }
    );
  });

  it("rewrites brand_ids when targetBrandId is provided", async () => {
    const row = await insertPromoGrantWithBrand([sourceBrandId]);

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId });

    expect(res.status).toBe(200);

    const [updated] = await db.select().from(localPromos).where(eq(localPromos.id, row.id));
    expect(updated.orgId).toBe(targetOrgId);
    expect(updated.brandIds).toEqual([targetBrandId]);
  });

  it("skips co-branding rows", async () => {
    await insertPromoGrantWithBrand([sourceBrandId, otherBrandId]);

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables[0]).toEqual({ tableName: "local_promos", count: 0 });
  });

  it("returns 502 when stripe-service fails", async () => {
    ssMocks.transferBrand.mockRejectedValue(new Error("SS down"));
    await insertPromoGrantWithBrand([sourceBrandId]);

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(502);
  });

  it("returns 400 for invalid body", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId: "not-a-uuid" });

    expect(res.status).toBe(400);
  });

  it("returns 401 without api key", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set({ "Content-Type": "application/json" })
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(401);
  });
});
