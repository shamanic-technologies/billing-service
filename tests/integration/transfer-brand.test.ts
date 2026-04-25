import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { creditProvisions } from "../../src/db/schema.js";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";

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

  beforeEach(async () => {
    await cleanTestData();
    await insertTestAccount({ orgId: sourceOrgId });
    await insertTestAccount({ orgId: targetOrgId });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("transfers solo-brand provisions from source to target org", async () => {
    await db.insert(creditProvisions).values({
      orgId: sourceOrgId,
      userId,
      amountCents: 100,
      brandIds: [sourceBrandId],
      description: "solo brand provision",
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "credit_provisions", count: 1 },
    ]);
  });

  it("rewrites brand_ids when targetBrandId is provided", async () => {
    const [provision] = await db.insert(creditProvisions).values({
      orgId: sourceOrgId,
      userId,
      amountCents: 100,
      brandIds: [sourceBrandId],
      description: "will be rewritten",
    }).returning();

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "credit_provisions", count: 1 },
    ]);

    // Verify the brand_ids was rewritten to targetBrandId
    const [updated] = await db
      .select()
      .from(creditProvisions)
      .where(eq(creditProvisions.id, provision.id));

    expect(updated.orgId).toBe(targetOrgId);
    expect(updated.brandIds).toEqual([targetBrandId]);
  });

  it("skips co-branding provisions (multiple brand IDs)", async () => {
    await db.insert(creditProvisions).values({
      orgId: sourceOrgId,
      userId,
      amountCents: 200,
      brandIds: [sourceBrandId, otherBrandId],
      description: "co-brand provision",
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "credit_provisions", count: 0 },
    ]);
  });

  it("skips provisions for a different brand", async () => {
    await db.insert(creditProvisions).values({
      orgId: sourceOrgId,
      userId,
      amountCents: 100,
      brandIds: [otherBrandId],
      description: "different brand",
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "credit_provisions", count: 0 },
    ]);
  });

  it("skips provisions with null brand_ids", async () => {
    await db.insert(creditProvisions).values({
      orgId: sourceOrgId,
      userId,
      amountCents: 100,
      brandIds: null,
      description: "no brand",
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "credit_provisions", count: 0 },
    ]);
  });

  it("is idempotent — second call is a no-op", async () => {
    await db.insert(creditProvisions).values({
      orgId: sourceOrgId,
      userId,
      amountCents: 100,
      brandIds: [sourceBrandId],
      description: "solo brand",
    });

    const res1 = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res1.status).toBe(200);
    expect(res1.body.updatedTables).toEqual([
      { tableName: "credit_provisions", count: 1 },
    ]);

    const res2 = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res2.status).toBe(200);
    expect(res2.body.updatedTables).toEqual([
      { tableName: "credit_provisions", count: 0 },
    ]);
  });

  it("is idempotent with targetBrandId — second call is a no-op", async () => {
    await db.insert(creditProvisions).values({
      orgId: sourceOrgId,
      userId,
      amountCents: 100,
      brandIds: [sourceBrandId],
      description: "solo brand",
    });

    const res1 = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId });

    expect(res1.status).toBe(200);
    expect(res1.body.updatedTables).toEqual([
      { tableName: "credit_provisions", count: 1 },
    ]);

    // Second call — brand_ids is now [targetBrandId], org_id is targetOrgId, so WHERE won't match
    const res2 = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId });

    expect(res2.status).toBe(200);
    expect(res2.body.updatedTables).toEqual([
      { tableName: "credit_provisions", count: 0 },
    ]);
  });

  it("returns 400 for invalid body", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("returns 401 without api key", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set({ "Content-Type": "application/json" })
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(401);
  });

  it("transfers multiple solo-brand provisions at once", async () => {
    await db.insert(creditProvisions).values([
      {
        orgId: sourceOrgId,
        userId,
        amountCents: 100,
        brandIds: [sourceBrandId],
        description: "provision 1",
      },
      {
        orgId: sourceOrgId,
        userId,
        amountCents: 200,
        brandIds: [sourceBrandId],
        description: "provision 2",
      },
      {
        orgId: sourceOrgId,
        userId,
        amountCents: 300,
        brandIds: [sourceBrandId, otherBrandId],
        description: "co-brand — should skip",
      },
    ]);

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(internalHeaders)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "credit_provisions", count: 2 },
    ]);
  });
});
