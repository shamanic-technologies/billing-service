import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db, sql } from "../../src/db/index.js";
import { brandDailyBudgets } from "../../src/db/schema.js";
import { attributeBrandBudgetToSingleFunnel } from "../../src/lib/single-funnel-attribution.js";

const orgId = "00000000-0000-0000-0000-00000000fa01";
const userId = "00000000-0000-0000-0000-00000000fa99";
const runId = "00000000-0000-0000-0000-00000000fabb";
const brandId = "00000000-0000-0000-0000-0000000fba01";

const apiKeyHeaders = { "X-API-Key": "test-api-key" };
const internalHeaders = { ...apiKeyHeaders, "x-org-id": orgId };

const brandReadPath = `/internal/brands/${brandId}/daily-budget`;
const funnelReadPath = `/internal/brands/${brandId}/funnel-budgets`;
const brandSetPath = `/v1/brands/${brandId}/daily-budget`;
const funnelOnePath = (key: string) =>
  `/v1/brands/${brandId}/funnel-budgets/${key}`;

/** The pre-feature state: a brand-level scalar and nothing else. */
async function seedScalar(
  dailyBudgetCents: string,
  updatedAt: Date
): Promise<void> {
  await db
    .insert(brandDailyBudgets)
    .values({ orgId, brandId, dailyBudgetCents, updatedAt });
}

describe("attributing a brand-level ceiling to its single funnel", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders(orgId, userId, runId);

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("leaves the brand-level read byte-identical, timestamp included", async () => {
    const updatedAt = new Date("2026-06-18T04:31:59.721Z");
    await seedScalar("5000.0000000000", updatedAt);

    const before = await request(app).get(brandReadPath).set(internalHeaders);
    expect(before.status).toBe(200);

    const outcome = await attributeBrandBudgetToSingleFunnel(
      orgId,
      brandId,
      "reply_meeting"
    );
    expect(outcome).toEqual({
      applied: true,
      dailyBudgetCents: "5000.0000000000",
      funnelKey: "reply_meeting",
    });

    const after = await request(app).get(brandReadPath).set(internalHeaders);
    expect(after.status).toBe(200);
    // Not "the same amount" — the same bytes, including updatedAt. This is an
    // attribution of an existing figure, so nothing about it may move.
    expect(after.body).toEqual(before.body);
  });

  it("makes the funnel read carry the ceiling, and the two totals agree", async () => {
    await seedScalar("3300.0000000000", new Date("2026-07-14T13:54:50.242Z"));
    await attributeBrandBudgetToSingleFunnel(orgId, brandId, "visit_form");

    const funnelRead = await request(app).get(funnelReadPath).set(internalHeaders);
    expect(funnelRead.status).toBe(200);
    expect(funnelRead.body.funnels).toEqual([
      {
        funnelKey: "visit_form",
        dailyBudgetCents: "3300.0000000000",
        updatedAt: expect.any(String),
      },
    ]);

    const brandRead = await request(app).get(brandReadPath).set(internalHeaders);
    expect(funnelRead.body.dailyBudgetCents).toBe(
      brandRead.body.dailyBudgetCents
    );
    expect(brandRead.body.dailyBudgetCents).toBe("3300.0000000000");
  });

  it("drops the superseded scalar row, so the brand is funnel-funded from then on", async () => {
    await seedScalar("2000.0000000000", new Date("2026-06-27T02:17:15.794Z"));
    await attributeBrandBudgetToSingleFunnel(orgId, brandId, "visit_form");

    const rows = await db.select().from(brandDailyBudgets);
    expect(rows).toHaveLength(0);

    // The brand-level write route now refuses, exactly as for any funnel-funded
    // brand — there can never be a stale scalar beside the ceilings.
    const write = await request(app)
      .patch(brandSetPath)
      .set(authHeaders)
      .send({ dailyBudgetCents: 9999 });
    expect(write.status).toBe(409);
  });

  it("writes NO history row — nothing about the brand-level number changed", async () => {
    await seedScalar("1500.0000000000", new Date("2026-08-05T13:31:32.764Z"));
    await attributeBrandBudgetToSingleFunnel(orgId, brandId, "reply_meeting");

    const history = await request(app)
      .get(`/internal/brands/${brandId}/daily-budget/history`)
      .set(internalHeaders);
    expect(history.status).toBe(200);
    expect(history.body.history).toEqual([]);
  });

  it("attributes a ceiling below the funnel's product minimum", async () => {
    // $15/day on a Sales Meeting funnel whose minimum is $24. The minimum
    // governs what a customer may newly state; this is a figure they are
    // already charged against.
    await seedScalar("1500.0000000000", new Date("2026-08-05T13:31:32.764Z"));
    const outcome = await attributeBrandBudgetToSingleFunnel(
      orgId,
      brandId,
      "reply_meeting"
    );
    expect(outcome.applied).toBe(true);

    const funnelRead = await request(app).get(funnelReadPath).set(internalHeaders);
    expect(funnelRead.body.dailyBudgetCents).toBe("1500.0000000000");
  });

  it("never overwrites a ceiling a human already set", async () => {
    await request(app)
      .patch(funnelOnePath("visit_signup"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 700 });

    const outcome = await attributeBrandBudgetToSingleFunnel(
      orgId,
      brandId,
      "reply_meeting"
    );
    expect(outcome).toEqual({
      applied: false,
      reason: "already funnel-funded — left exactly as it is",
    });

    const funnelRead = await request(app).get(funnelReadPath).set(internalHeaders);
    expect(funnelRead.body.funnels).toEqual([
      {
        funnelKey: "visit_signup",
        dailyBudgetCents: "700.0000000000",
        updatedAt: expect.any(String),
      },
    ]);
  });

  it("is idempotent — a second run changes nothing", async () => {
    await seedScalar("1300.0000000000", new Date("2026-06-18T05:22:23.748Z"));
    await attributeBrandBudgetToSingleFunnel(orgId, brandId, "visit_signup");

    const afterFirst = await request(app).get(funnelReadPath).set(internalHeaders);

    const second = await attributeBrandBudgetToSingleFunnel(
      orgId,
      brandId,
      "visit_signup"
    );
    expect(second.applied).toBe(false);

    const afterSecond = await request(app).get(funnelReadPath).set(internalHeaders);
    expect(afterSecond.body).toEqual(afterFirst.body);
  });

  it("is a no-op for a brand with no brand-level ceiling at all", async () => {
    const outcome = await attributeBrandBudgetToSingleFunnel(
      orgId,
      brandId,
      "visit_form"
    );
    expect(outcome).toEqual({
      applied: false,
      reason: "no brand-level ceiling to attribute",
    });

    const funnelRead = await request(app).get(funnelReadPath).set(internalHeaders);
    expect(funnelRead.body.funnels).toEqual([]);
    expect(funnelRead.body.dailyBudgetCents).toBeNull();
  });

  it("is reversible — the scalar is fully recoverable from the ceiling", async () => {
    const updatedAt = new Date("2026-07-07T14:04:24.817Z");
    await seedScalar("800.0000000000", updatedAt);
    const before = await request(app).get(brandReadPath).set(internalHeaders);

    await attributeBrandBudgetToSingleFunnel(orgId, brandId, "reply_meeting");

    await sql`
      INSERT INTO brand_daily_budgets (org_id, brand_id, daily_budget_cents, updated_at)
      SELECT org_id, brand_id, daily_budget_cents, updated_at
        FROM brand_funnel_daily_budgets
       WHERE org_id = ${orgId} AND brand_id = ${brandId}
    `;
    await sql`
      DELETE FROM brand_funnel_daily_budgets
       WHERE org_id = ${orgId} AND brand_id = ${brandId}
    `;

    const restored = await request(app).get(brandReadPath).set(internalHeaders);
    expect(restored.body).toEqual(before.body);
  });
});
