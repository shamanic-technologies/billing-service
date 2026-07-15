import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const orgId = "00000000-0000-0000-0000-00000000b201";
const otherOrgId = "00000000-0000-0000-0000-00000000b202";
const userId = "00000000-0000-0000-0000-00000000b299";
const runId = "00000000-0000-0000-0000-00000000baaa";
const brandId = "00000000-0000-0000-0000-0000000bd601";
const otherBrandId = "00000000-0000-0000-0000-0000000bd999";

const apiKeyHeaders = { "X-API-Key": "test-api-key" };
const internalHeaders = (id: string) => ({ ...apiKeyHeaders, "x-org-id": id });

function readPath(id: string) {
  return `/internal/brands/${id}/daily-budget`;
}
function setPath(id: string) {
  return `/v1/brands/${id}/daily-budget`;
}
function historyPath(id: string) {
  return `/internal/brands/${id}/daily-budget/history`;
}

describe("brand daily budget (store + serve)", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders(orgId, userId, runId);

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("PATCH sets a brand's daily budget → 200 echo", async () => {
    const res = await request(app)
      .patch(setPath(brandId))
      .set(authHeaders)
      .send({ dailyBudgetCents: 2500 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      brandId,
      orgId,
      dailyBudgetCents: "2500.0000000000",
      updatedAt: expect.any(String),
    });
  });

  it("internal read reflects the latest write", async () => {
    await request(app)
      .patch(setPath(brandId))
      .set(authHeaders)
      .send({ dailyBudgetCents: 2500 });

    const res = await request(app)
      .get(readPath(brandId))
      .set(internalHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      brandId,
      dailyBudgetCents: "2500.0000000000",
      updatedAt: expect.any(String),
    });
  });

  it("a second write updates in place; read reflects the latest", async () => {
    await request(app)
      .patch(setPath(brandId))
      .set(authHeaders)
      .send({ dailyBudgetCents: 2500 });
    await request(app)
      .patch(setPath(brandId))
      .set(authHeaders)
      .send({ dailyBudgetCents: 9900 });

    const res = await request(app)
      .get(readPath(brandId))
      .set(internalHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body.dailyBudgetCents).toBe("9900.0000000000");
  });

  it("unset brand → 200 with null budget", async () => {
    const res = await request(app)
      .get(readPath(otherBrandId))
      .set(internalHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      brandId: otherBrandId,
      dailyBudgetCents: null,
      updatedAt: null,
    });
  });

  it("stores independent budgets for the same brand in different orgs", async () => {
    await request(app)
      .patch(setPath(brandId))
      .set(authHeaders)
      .send({ dailyBudgetCents: 2500 });
    await request(app)
      .patch(setPath(brandId))
      .set(getAuthHeaders(otherOrgId, userId, runId))
      .send({ dailyBudgetCents: 9900 });

    const orgARes = await request(app)
      .get(readPath(brandId))
      .set(internalHeaders(orgId));
    const orgBRes = await request(app)
      .get(readPath(brandId))
      .set(internalHeaders(otherOrgId));

    expect(orgARes.status).toBe(200);
    expect(orgBRes.status).toBe(200);
    expect(orgARes.body.dailyBudgetCents).toBe("2500.0000000000");
    expect(orgBRes.body.dailyBudgetCents).toBe("9900.0000000000");
  });

  it("returns null when this org has no budget even if another org has one", async () => {
    await request(app)
      .patch(setPath(brandId))
      .set(getAuthHeaders(otherOrgId, userId, runId))
      .send({ dailyBudgetCents: 9900 });

    const res = await request(app)
      .get(readPath(brandId))
      .set(internalHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      brandId,
      dailyBudgetCents: null,
      updatedAt: null,
    });
  });

  it("allows 0 (explicit pause)", async () => {
    const res = await request(app)
      .patch(setPath(brandId))
      .set(authHeaders)
      .send({ dailyBudgetCents: 0 });

    expect(res.status).toBe(200);
    expect(res.body.dailyBudgetCents).toBe("0.0000000000");
  });

  it("rejects a negative budget with 400", async () => {
    const res = await request(app)
      .patch(setPath(brandId))
      .set(authHeaders)
      .send({ dailyBudgetCents: -1 });

    expect(res.status).toBe(400);
  });

  it("rejects a missing dailyBudgetCents with 400", async () => {
    const res = await request(app)
      .patch(setPath(brandId))
      .set(authHeaders)
      .send({});

    expect(res.status).toBe(400);
  });

  it("rejects a non-UUID brandId on PATCH with 400", async () => {
    const res = await request(app)
      .patch(setPath("not-a-uuid"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 2500 });

    expect(res.status).toBe(400);
  });

  it("rejects a non-UUID brandId on GET with 400", async () => {
    const res = await request(app)
      .get(readPath("not-a-uuid"))
      .set(internalHeaders(orgId));

    expect(res.status).toBe(400);
  });

  it("internal read requires service auth (401 without x-api-key)", async () => {
    const res = await request(app)
      .get(readPath(brandId))
      .set({ "x-org-id": orgId });
    expect(res.status).toBe(401);
  });

  it("internal read requires x-org-id", async () => {
    const res = await request(app).get(readPath(brandId)).set(apiKeyHeaders);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("x-org-id header is required");
  });

  it("internal read rejects invalid x-org-id", async () => {
    const res = await request(app)
      .get(readPath(brandId))
      .set({ ...apiKeyHeaders, "x-org-id": "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("x-org-id must be a valid UUID");
  });

  it("PATCH requires org headers (400 without x-org-id)", async () => {
    const res = await request(app)
      .patch(setPath(brandId))
      .set(apiKeyHeaders)
      .send({ dailyBudgetCents: 2500 });

    expect(res.status).toBe(400);
  });

  // --- daily-budget change history (forward-only timeline) ---

  it("history records each write in chronological order", async () => {
    for (const amount of [5000, 0, 7500]) {
      await request(app)
        .patch(setPath(brandId))
        .set(authHeaders)
        .send({ dailyBudgetCents: amount });
    }

    const res = await request(app)
      .get(historyPath(brandId))
      .set(internalHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body.brandId).toBe(brandId);
    expect(res.body.history.map((h: { dailyBudgetCents: string }) => h.dailyBudgetCents)).toEqual([
      "5000.0000000000",
      "0.0000000000",
      "7500.0000000000",
    ]);
    for (const entry of res.body.history) {
      expect(typeof entry.changedAt).toBe("string");
    }
  });

  it("history is empty for a brand with no writes", async () => {
    const res = await request(app)
      .get(historyPath(otherBrandId))
      .set(internalHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ brandId: otherBrandId, history: [] });
  });

  it("history is scoped per org (no cross-tenant leak)", async () => {
    await request(app)
      .patch(setPath(brandId))
      .set(authHeaders)
      .send({ dailyBudgetCents: 2500 });
    await request(app)
      .patch(setPath(brandId))
      .set(getAuthHeaders(otherOrgId, userId, runId))
      .send({ dailyBudgetCents: 9900 });

    const orgARes = await request(app)
      .get(historyPath(brandId))
      .set(internalHeaders(orgId));
    const orgBRes = await request(app)
      .get(historyPath(brandId))
      .set(internalHeaders(otherOrgId));

    expect(orgARes.body.history.map((h: { dailyBudgetCents: string }) => h.dailyBudgetCents)).toEqual([
      "2500.0000000000",
    ]);
    expect(orgBRes.body.history.map((h: { dailyBudgetCents: string }) => h.dailyBudgetCents)).toEqual([
      "9900.0000000000",
    ]);
  });

  it("current-value read still returns only the latest (unchanged behavior)", async () => {
    for (const amount of [5000, 0, 7500]) {
      await request(app)
        .patch(setPath(brandId))
        .set(authHeaders)
        .send({ dailyBudgetCents: amount });
    }

    const res = await request(app)
      .get(readPath(brandId))
      .set(internalHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      brandId,
      dailyBudgetCents: "7500.0000000000",
      updatedAt: expect.any(String),
    });
  });

  it("history read requires service auth (401 without x-api-key)", async () => {
    const res = await request(app)
      .get(historyPath(brandId))
      .set({ "x-org-id": orgId });
    expect(res.status).toBe(401);
  });

  it("history read requires x-org-id", async () => {
    const res = await request(app).get(historyPath(brandId)).set(apiKeyHeaders);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("x-org-id header is required");
  });

  it("history read rejects a non-UUID brandId with 400", async () => {
    const res = await request(app)
      .get(historyPath("not-a-uuid"))
      .set(internalHeaders(orgId));
    expect(res.status).toBe(400);
  });
});
