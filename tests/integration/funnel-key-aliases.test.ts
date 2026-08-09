import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const orgId = "00000000-0000-0000-0000-00000000fc01";
const userId = "00000000-0000-0000-0000-00000000fc99";
const runId = "00000000-0000-0000-0000-00000000fcbb";
const brandId = "00000000-0000-0000-0000-0000000fca01";

const apiKeyHeaders = { "X-API-Key": "test-api-key" };
const internalHeaders = { ...apiKeyHeaders, "x-org-id": orgId };

const funnelReadPath = `/internal/brands/${brandId}/funnel-budgets`;
const brandReadPath = `/internal/brands/${brandId}/daily-budget`;
const funnelSetPath = `/v1/brands/${brandId}/funnel-budgets`;
const funnelOnePath = (key: string) =>
  `/v1/brands/${brandId}/funnel-budgets/${key}`;

/**
 * brand-service renamed its funnel keys and now emits the canonical four while
 * accepting the old ones forever. billing stores the old spellings — that is
 * what the dashboard renders — and must accept both on write, for the same
 * reason brand-service does, and because the two spellings name ONE funnel that
 * the primary key would otherwise store twice.
 */
describe("funnel-key aliases on the write surface", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders(orgId, userId, runId);

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("accepts a canonical key on the whole-set write and stores the stored spelling", async () => {
    const res = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "website_purchases", dailyBudgetCents: 500 },
          { funnelKey: "form_magnet", dailyBudgetCents: 700 },
        ],
      });
    expect(res.status).toBe(200);
    // Reads still answer the stored spelling — no consumer changes.
    expect(res.body.funnels).toEqual([
      {
        funnelKey: "visit_signup",
        dailyBudgetCents: "500.0000000000",
        updatedAt: expect.any(String),
      },
      {
        funnelKey: "visit_form",
        dailyBudgetCents: "700.0000000000",
        updatedAt: expect.any(String),
      },
    ]);
    expect(res.body.dailyBudgetCents).toBe("1200.0000000000");
  });

  it("accepts a canonical key on the single-funnel write", async () => {
    const res = await request(app)
      .patch(funnelOnePath("sales_meetings_from_conversation"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 2400 });
    expect(res.status).toBe(200);
    expect(res.body.funnels).toEqual([
      {
        funnelKey: "reply_meeting",
        dailyBudgetCents: "2400.0000000000",
        updatedAt: expect.any(String),
      },
    ]);
  });

  it("treats the two spellings of one funnel as ONE row, never two", async () => {
    // The whole point: the composite PK sees two strings, the customer sells
    // through one funnel. Storing both would DOUBLE the brand-level total,
    // which is the sum of the ceilings.
    await request(app)
      .patch(funnelOnePath("visit_form"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 700 });

    const res = await request(app)
      .patch(funnelOnePath("form_magnet"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 900 });
    expect(res.status).toBe(200);
    expect(res.body.funnels).toHaveLength(1);
    expect(res.body.funnels[0]).toMatchObject({
      funnelKey: "visit_form",
      dailyBudgetCents: "900.0000000000",
    });

    const brandRead = await request(app).get(brandReadPath).set(internalHeaders);
    expect(brandRead.body.dailyBudgetCents).toBe("900.0000000000");
  });

  it("rejects a set naming the same funnel under both spellings", async () => {
    const res = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_form", dailyBudgetCents: 700 },
          { funnelKey: "form_magnet", dailyBudgetCents: 900 },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("appears twice");

    const read = await request(app).get(funnelReadPath).set(internalHeaders);
    expect(read.body.funnels).toEqual([]);
  });

  it("applies the product minimum to the funnel the alias names", async () => {
    // $10/day on a Sales Meeting funnel, whose minimum is $24 — refused whether
    // it is named the old way or the new one.
    const res = await request(app)
      .patch(funnelOnePath("sales_meetings_from_website"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Sales Meeting (visit)");
  });

  it("still rejects a spelling that names no funnel, quoting every accepted one", async () => {
    const res = await request(app)
      .patch(funnelOnePath("carrier_pigeon"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 500 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("carrier_pigeon");
    expect(res.body.error).toContain("visit_form");
    expect(res.body.error).toContain("form_magnet");
  });
});
