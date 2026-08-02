import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const orgId = "00000000-0000-0000-0000-00000000f101";
const otherOrgId = "00000000-0000-0000-0000-00000000f102";
const userId = "00000000-0000-0000-0000-00000000f199";
const runId = "00000000-0000-0000-0000-00000000faaa";
const brandId = "00000000-0000-0000-0000-0000000fb601";
const otherBrandId = "00000000-0000-0000-0000-0000000fb999";

const apiKeyHeaders = { "X-API-Key": "test-api-key" };
const internalHeaders = (id: string) => ({ ...apiKeyHeaders, "x-org-id": id });

const brandReadPath = (id: string) => `/internal/brands/${id}/daily-budget`;
const brandSetPath = (id: string) => `/v1/brands/${id}/daily-budget`;
const brandHistoryPath = (id: string) =>
  `/internal/brands/${id}/daily-budget/history`;
const internalFunnelPath = (id: string) =>
  `/internal/brands/${id}/funnel-budgets`;
const funnelSetPath = (id: string) => `/v1/brands/${id}/funnel-budgets`;
const funnelOnePath = (id: string, key: string) =>
  `/v1/brands/${id}/funnel-budgets/${key}`;

type FunnelRow = { funnelKey: string; dailyBudgetCents: string };

describe("per-funnel daily budgets", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders(orgId, userId, runId);

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  // --- No per-funnel ceilings: behaves exactly as today (no backfill) ---

  it("a brand with no per-funnel ceilings keeps its brand-level budget authoritative", async () => {
    await request(app)
      .patch(brandSetPath(brandId))
      .set(authHeaders)
      .send({ dailyBudgetCents: 2500 });

    const brandRead = await request(app)
      .get(brandReadPath(brandId))
      .set(internalHeaders(orgId));
    expect(brandRead.status).toBe(200);
    expect(brandRead.body).toEqual({
      brandId,
      dailyBudgetCents: "2500.0000000000",
      updatedAt: expect.any(String),
    });

    const funnelRead = await request(app)
      .get(internalFunnelPath(brandId))
      .set(internalHeaders(orgId));
    expect(funnelRead.status).toBe(200);
    expect(funnelRead.body).toEqual({
      brandId,
      dailyBudgetCents: "2500.0000000000",
      funnels: [],
    });
  });

  it("a brand with nothing set at all reads null on both surfaces", async () => {
    const funnelRead = await request(app)
      .get(internalFunnelPath(otherBrandId))
      .set(internalHeaders(orgId));
    expect(funnelRead.status).toBe(200);
    expect(funnelRead.body).toEqual({
      brandId: otherBrandId,
      dailyBudgetCents: null,
      funnels: [],
    });

    const brandRead = await request(app)
      .get(brandReadPath(otherBrandId))
      .set(internalHeaders(orgId));
    expect(brandRead.body.dailyBudgetCents).toBeNull();
  });

  // --- Whole-set write ---

  it("PUT writes the whole set; the brand-level read equals their SUM", async () => {
    const res = await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_signup", dailyBudgetCents: 100 },
          { funnelKey: "reply_meeting", dailyBudgetCents: 2400 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.brandId).toBe(brandId);
    expect(res.body.orgId).toBe(orgId);
    expect(res.body.dailyBudgetCents).toBe("2500.0000000000");
    expect(
      res.body.funnels.map((f: FunnelRow) => [f.funnelKey, f.dailyBudgetCents])
    ).toEqual([
      ["reply_meeting", "2400.0000000000"],
      ["visit_signup", "100.0000000000"],
    ]);

    const brandRead = await request(app)
      .get(brandReadPath(brandId))
      .set(internalHeaders(orgId));
    expect(brandRead.status).toBe(200);
    expect(brandRead.body).toEqual({
      brandId,
      dailyBudgetCents: "2500.0000000000",
      updatedAt: expect.any(String),
    });
  });

  it("PUT replaces the set — funnels absent from the body are removed", async () => {
    await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_signup", dailyBudgetCents: 500 },
          { funnelKey: "visit_form", dailyBudgetCents: 300 },
        ],
      });

    const res = await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({ funnels: [{ funnelKey: "visit_form", dailyBudgetCents: 300 }] });

    expect(res.status).toBe(200);
    expect(res.body.funnels.map((f: FunnelRow) => f.funnelKey)).toEqual([
      "visit_form",
    ]);
    expect(res.body.dailyBudgetCents).toBe("300.0000000000");
  });

  it("accepts a set where EVERY funnel is zero (a brand in pause)", async () => {
    const res = await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "reply_meeting", dailyBudgetCents: 0 },
          { funnelKey: "visit_meeting", dailyBudgetCents: 0 },
          { funnelKey: "visit_signup", dailyBudgetCents: 0 },
          { funnelKey: "visit_form", dailyBudgetCents: 0 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.dailyBudgetCents).toBe("0.0000000000");

    const brandRead = await request(app)
      .get(brandReadPath(brandId))
      .set(internalHeaders(orgId));
    expect(brandRead.body.dailyBudgetCents).toBe("0.0000000000");
  });

  it("a funded funnel exactly at its minimum is accepted", async () => {
    const res = await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_meeting", dailyBudgetCents: 2400 },
          { funnelKey: "visit_form", dailyBudgetCents: 100 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.dailyBudgetCents).toBe("2500.0000000000");
  });

  // --- Minimums ---

  it("refuses a funded funnel below its minimum with a readable reason", async () => {
    const res = await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({
        funnels: [{ funnelKey: "reply_meeting", dailyBudgetCents: 1000 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Sales Meeting (reply)");
    expect(res.body.error).toContain("$24/day");
    expect(res.body.error).toContain("$10/day");
  });

  it("refuses a funded website-purchase funnel below $1/day", async () => {
    const res = await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({
        funnels: [{ funnelKey: "visit_signup", dailyBudgetCents: 50 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Website Purchase");
    expect(res.body.error).toContain("$1/day");
  });

  it("a rejected set leaves NOTHING half-applied", async () => {
    const res = await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_signup", dailyBudgetCents: 500 },
          { funnelKey: "reply_meeting", dailyBudgetCents: 1 },
        ],
      });
    expect(res.status).toBe(400);

    const read = await request(app)
      .get(internalFunnelPath(brandId))
      .set(internalHeaders(orgId));
    expect(read.body.funnels).toEqual([]);
    expect(read.body.dailyBudgetCents).toBeNull();
  });

  it("a rejected set does not disturb the ceilings already stored", async () => {
    await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({
        funnels: [{ funnelKey: "visit_signup", dailyBudgetCents: 500 }],
      });

    const res = await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_signup", dailyBudgetCents: 900 },
          { funnelKey: "visit_meeting", dailyBudgetCents: 5 },
        ],
      });
    expect(res.status).toBe(400);

    const read = await request(app)
      .get(internalFunnelPath(brandId))
      .set(internalHeaders(orgId));
    expect(
      read.body.funnels.map((f: FunnelRow) => [f.funnelKey, f.dailyBudgetCents])
    ).toEqual([["visit_signup", "500.0000000000"]]);
  });

  it("a funnel at zero is accepted where the same funnel below its minimum is not", async () => {
    const zero = await request(app)
      .patch(funnelOnePath(brandId, "reply_meeting"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 0 });
    expect(zero.status).toBe(200);

    const belowMin = await request(app)
      .patch(funnelOnePath(brandId, "reply_meeting"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 2399 });
    expect(belowMin.status).toBe(400);
  });

  // --- Single-funnel write ---

  it("PATCH sets one funnel and leaves the others untouched", async () => {
    await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_signup", dailyBudgetCents: 100 },
          { funnelKey: "reply_meeting", dailyBudgetCents: 2400 },
        ],
      });

    const res = await request(app)
      .patch(funnelOnePath(brandId, "visit_signup"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 900 });

    expect(res.status).toBe(200);
    expect(
      res.body.funnels.map((f: FunnelRow) => [f.funnelKey, f.dailyBudgetCents])
    ).toEqual([
      ["reply_meeting", "2400.0000000000"],
      ["visit_signup", "900.0000000000"],
    ]);
    expect(res.body.dailyBudgetCents).toBe("3300.0000000000");

    const brandRead = await request(app)
      .get(brandReadPath(brandId))
      .set(internalHeaders(orgId));
    expect(brandRead.body.dailyBudgetCents).toBe("3300.0000000000");
  });

  it("PATCH on a brand with no ceilings yet starts the set", async () => {
    const res = await request(app)
      .patch(funnelOnePath(brandId, "visit_form"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 250 });

    expect(res.status).toBe(200);
    expect(res.body.dailyBudgetCents).toBe("250.0000000000");
  });

  it("rejects an unknown funnel key with 400", async () => {
    const patched = await request(app)
      .patch(funnelOnePath(brandId, "carrier_pigeon"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 500 });
    expect(patched.status).toBe(400);
    expect(patched.body.error).toContain("carrier_pigeon");

    const put = await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({ funnels: [{ funnelKey: "carrier_pigeon", dailyBudgetCents: 500 }] });
    expect(put.status).toBe(400);
  });

  it("rejects the same funnel twice in one set with 400", async () => {
    const res = await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_form", dailyBudgetCents: 100 },
          { funnelKey: "visit_form", dailyBudgetCents: 200 },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("twice");
  });

  it("rejects a negative ceiling with 400", async () => {
    const res = await request(app)
      .patch(funnelOnePath(brandId, "visit_form"))
      .set(authHeaders)
      .send({ dailyBudgetCents: -1 });
    expect(res.status).toBe(400);
  });

  it("rejects an empty funnels array with 400", async () => {
    const res = await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({ funnels: [] });
    expect(res.status).toBe(400);
  });

  // --- Coherence with the brand-level surfaces ---

  it("the brand-level write is refused (409) once the brand is funnel-funded", async () => {
    await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({ funnels: [{ funnelKey: "visit_form", dailyBudgetCents: 100 }] });

    const res = await request(app)
      .patch(brandSetPath(brandId))
      .set(authHeaders)
      .send({ dailyBudgetCents: 9900 });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("per sales funnel");

    const brandRead = await request(app)
      .get(brandReadPath(brandId))
      .set(internalHeaders(orgId));
    expect(brandRead.body.dailyBudgetCents).toBe("100.0000000000");
  });

  it("the first per-funnel write supersedes the brand-level scalar", async () => {
    await request(app)
      .patch(brandSetPath(brandId))
      .set(authHeaders)
      .send({ dailyBudgetCents: 9900 });

    await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({ funnels: [{ funnelKey: "visit_form", dailyBudgetCents: 100 }] });

    const brandRead = await request(app)
      .get(brandReadPath(brandId))
      .set(internalHeaders(orgId));
    expect(brandRead.body.dailyBudgetCents).toBe("100.0000000000");
  });

  it("the change history records the brand-level TOTAL of each per-funnel write", async () => {
    await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_signup", dailyBudgetCents: 100 },
          { funnelKey: "reply_meeting", dailyBudgetCents: 2400 },
        ],
      });
    await request(app)
      .patch(funnelOnePath(brandId, "visit_signup"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 600 });

    const res = await request(app)
      .get(brandHistoryPath(brandId))
      .set(internalHeaders(orgId));

    expect(res.status).toBe(200);
    expect(
      res.body.history.map((h: { dailyBudgetCents: string }) => h.dailyBudgetCents)
    ).toEqual(["2500.0000000000", "3000.0000000000"]);
  });

  // --- Tenancy + auth ---

  it("keeps per-funnel ceilings independent across orgs for the same brand", async () => {
    await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({ funnels: [{ funnelKey: "visit_form", dailyBudgetCents: 100 }] });
    await request(app)
      .put(funnelSetPath(brandId))
      .set(getAuthHeaders(otherOrgId, userId, runId))
      .send({ funnels: [{ funnelKey: "visit_signup", dailyBudgetCents: 700 }] });

    const orgARead = await request(app)
      .get(internalFunnelPath(brandId))
      .set(internalHeaders(orgId));
    const orgBRead = await request(app)
      .get(internalFunnelPath(brandId))
      .set(internalHeaders(otherOrgId));

    expect(orgARead.body.dailyBudgetCents).toBe("100.0000000000");
    expect(orgBRead.body.dailyBudgetCents).toBe("700.0000000000");
  });

  it("serves the user read of a brand's own ceilings", async () => {
    await request(app)
      .put(funnelSetPath(brandId))
      .set(authHeaders)
      .send({ funnels: [{ funnelKey: "visit_form", dailyBudgetCents: 100 }] });

    const res = await request(app)
      .get(funnelSetPath(brandId))
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      brandId,
      orgId,
      dailyBudgetCents: "100.0000000000",
      funnels: [
        {
          funnelKey: "visit_form",
          dailyBudgetCents: "100.0000000000",
          updatedAt: expect.any(String),
        },
      ],
    });
  });

  it("internal read requires service auth and a valid x-org-id", async () => {
    const noKey = await request(app)
      .get(internalFunnelPath(brandId))
      .set({ "x-org-id": orgId });
    expect(noKey.status).toBe(401);

    const noOrg = await request(app)
      .get(internalFunnelPath(brandId))
      .set(apiKeyHeaders);
    expect(noOrg.status).toBe(400);
    expect(noOrg.body.error).toBe("x-org-id header is required");

    const badOrg = await request(app)
      .get(internalFunnelPath(brandId))
      .set({ ...apiKeyHeaders, "x-org-id": "not-a-uuid" });
    expect(badOrg.status).toBe(400);
  });

  it("rejects a non-UUID brandId on every per-funnel route with 400", async () => {
    const read = await request(app)
      .get(internalFunnelPath("not-a-uuid"))
      .set(internalHeaders(orgId));
    expect(read.status).toBe(400);

    const put = await request(app)
      .put(funnelSetPath("not-a-uuid"))
      .set(authHeaders)
      .send({ funnels: [{ funnelKey: "visit_form", dailyBudgetCents: 100 }] });
    expect(put.status).toBe(400);

    const patched = await request(app)
      .patch(funnelOnePath("not-a-uuid", "visit_form"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 100 });
    expect(patched.status).toBe(400);
  });

  it("per-funnel writes require org headers", async () => {
    const res = await request(app)
      .put(funnelSetPath(brandId))
      .set(apiKeyHeaders)
      .send({ funnels: [{ funnelKey: "visit_form", dailyBudgetCents: 100 }] });
    expect(res.status).toBe(400);
  });
});
