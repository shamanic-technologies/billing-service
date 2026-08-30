import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { localPromos, localPromoCodes } from "../../src/db/schema.js";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, insertTestPromoCode, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import type { StripeCustomer } from "../../src/lib/stripe-service-client.js";

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

  function makeCustomer(id: string, metadata: Record<string, string>): StripeCustomer {
    return {
      id,
      object: "customer",
      balance: 0,
      metadata,
      invoice_settings: { default_payment_method: null },
    };
  }

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

  it("patches solo-brand SS customers + transfers solo-brand local_promos rows", async () => {
    ssMocks.listAllCustomersForOrg.mockResolvedValue(
      [
        makeCustomer("cus_solo_match", { org_id: sourceOrgId, brand_id: sourceBrandId }),
      ]
    );
    await insertPromoGrantWithBrand([sourceBrandId]);

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "local_promos", count: 1 },
      { tableName: "stripe_service_customers", count: 1 },
    ]);
    // The org is named in the path and nothing else is sent: no fabricated
    // x-org-id, no zero-uuid x-user-id. One argument, and it is the org id.
    expect(ssMocks.listAllCustomersForOrg).toHaveBeenCalledWith(sourceOrgId);
    expect(ssMocks.listAllCustomersForOrg.mock.calls[0]).toHaveLength(1);
    expect(ssMocks.setCustomerMetadata).toHaveBeenCalledWith(
      "cus_solo_match",
      expect.objectContaining({ org_id: targetOrgId })
    );
    expect(ssMocks.setCustomerMetadata.mock.calls[0]).toHaveLength(2);
  });

  it("patches brand_id when targetBrandId provided", async () => {
    ssMocks.listAllCustomersForOrg.mockResolvedValue(
      [
        makeCustomer("cus_solo_rename", { org_id: sourceOrgId, brand_id: sourceBrandId }),
      ]
    );
    const row = await insertPromoGrantWithBrand([sourceBrandId]);

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId });

    expect(res.status).toBe(200);
    expect(ssMocks.setCustomerMetadata).toHaveBeenCalledWith(
      "cus_solo_rename",
      expect.objectContaining({
        org_id: targetOrgId,
        brand_id: targetBrandId,
      })
    );

    const [updated] = await db.select().from(localPromos).where(eq(localPromos.id, row.id));
    expect(updated.orgId).toBe(targetOrgId);
    expect(updated.brandIds).toEqual([targetBrandId]);
  });

  it("skips multi-brand customers (CSV brand_id with multiple entries)", async () => {
    ssMocks.listAllCustomersForOrg.mockResolvedValue(
      [
        makeCustomer("cus_multi", {
          org_id: sourceOrgId,
          brand_id: `${sourceBrandId},${otherBrandId}`,
        }),
      ]
    );

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toContainEqual({
      tableName: "stripe_service_customers",
      count: 0,
    });
    expect(ssMocks.setCustomerMetadata).not.toHaveBeenCalled();
  });

  it("skips customers with non-matching brand_id", async () => {
    ssMocks.listAllCustomersForOrg.mockResolvedValue(
      [
        makeCustomer("cus_other", { org_id: sourceOrgId, brand_id: otherBrandId }),
      ]
    );

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toContainEqual({
      tableName: "stripe_service_customers",
      count: 0,
    });
    expect(ssMocks.setCustomerMetadata).not.toHaveBeenCalled();
  });

  it("skips customers with no brand_id metadata", async () => {
    ssMocks.listAllCustomersForOrg.mockResolvedValue(
      [makeCustomer("cus_no_brand", { org_id: sourceOrgId })]
    );

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toContainEqual({
      tableName: "stripe_service_customers",
      count: 0,
    });
    expect(ssMocks.setCustomerMetadata).not.toHaveBeenCalled();
  });

  it("trims whitespace inside CSV brand_id", async () => {
    ssMocks.listAllCustomersForOrg.mockResolvedValue(
      [
        makeCustomer("cus_ws", { org_id: sourceOrgId, brand_id: ` ${sourceBrandId} ` }),
      ]
    );

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(ssMocks.setCustomerMetadata).toHaveBeenCalledTimes(1);
  });

  it("considers EVERY customer the org holds, not just the newest", async () => {
    // 4 prod orgs hold more than one Stripe customer. The read returns the whole
    // set in one call, so a transfer can never strand the ones it never listed.
    ssMocks.listAllCustomersForOrg.mockResolvedValue([
      makeCustomer("cus_first", { org_id: sourceOrgId, brand_id: sourceBrandId }),
      makeCustomer("cus_second", { org_id: sourceOrgId, brand_id: sourceBrandId }),
    ]);

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(ssMocks.listAllCustomersForOrg).toHaveBeenCalledTimes(1);
    expect(ssMocks.setCustomerMetadata).toHaveBeenCalledTimes(2);
    expect(res.body.updatedTables).toContainEqual({
      tableName: "stripe_service_customers",
      count: 2,
    });
  });

  it("skips co-branding local_promos rows", async () => {
    await insertPromoGrantWithBrand([sourceBrandId, otherBrandId]);

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables[0]).toEqual({ tableName: "local_promos", count: 0 });
  });

  it("returns 502 when stripe-service list fails", async () => {
    ssMocks.listAllCustomersForOrg.mockRejectedValue(new Error("SS down"));
    await insertPromoGrantWithBrand([sourceBrandId]);

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(502);
  });

  it("returns 502 with partial counts when an update fails mid-loop", async () => {
    ssMocks.listAllCustomersForOrg.mockResolvedValue(
      [
        makeCustomer("cus_ok", { org_id: sourceOrgId, brand_id: sourceBrandId }),
        makeCustomer("cus_fail", { org_id: sourceOrgId, brand_id: sourceBrandId }),
      ]
    );
    ssMocks.setCustomerMetadata.mockImplementation((id: string) => {
      if (id === "cus_fail") return Promise.reject(new Error("SS update failed"));
      return Promise.resolve(makeCustomer(id, {}));
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(502);
    expect(res.body.partial).toEqual({
      stripe_service_customers_patched: 1,
      total_targets: 2,
    });
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
