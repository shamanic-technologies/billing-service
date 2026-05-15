import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestAccount,
  insertTestPromoGrant,
  closeDb,
} from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

describe("GET /public/stats/billing", () => {
  const app = createTestApp();
  const orgA = "00000000-0000-0000-0000-000000000001";
  const orgB = "00000000-0000-0000-0000-000000000002";
  const userId = "00000000-0000-0000-0000-000000000099";
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("returns zeros when no data and no SS stats", async () => {
    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body.total_accounts).toBe(0);
    expect(res.body.accounts_with_payment_method).toBe(0);
    expect(res.body.total_credited_cents).toBe("0.0000000000");
    expect(res.body.total_paid_cents).toBe("0.0000000000");
    expect(res.body.total_local_credits_cents).toBe("0.0000000000");
    expect(res.body.monthly_growth).toEqual([]);
    expect(res.body.weekly_growth).toEqual([]);
  });

  it("does not require authentication", async () => {
    const res = await request(app).get("/public/stats/billing");
    expect(res.status).toBe(200);
  });

  it("composes total_credited from SS paid + local promo credits", async () => {
    await insertTestAccount({ orgId: orgA });
    await insertTestAccount({ orgId: orgB });
    await insertTestPromoGrant({ orgId: orgA, userId, amountCents: 200, promoCode: "welcome" });
    await insertTestPromoGrant({ orgId: orgB, userId, amountCents: 200, promoCode: "welcome" });

    ssMocks.getStats.mockResolvedValue({
      total_paid_cents: "15000.0000000000",
      accounts_with_payment_method: 1,
      monthly_growth: [],
      weekly_growth: [],
    });

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body.total_accounts).toBe(2);
    expect(res.body.accounts_with_payment_method).toBe(1);
    expect(res.body.total_paid_cents).toBe("15000.0000000000");
    expect(res.body.total_local_credits_cents).toBe("400.0000000000");
    expect(res.body.total_credited_cents).toBe("15400.0000000000");
  });

  it("merges monthly_growth from SS + local promos by period", async () => {
    await insertTestAccount({ orgId: orgA });
    await insertTestPromoGrant({ orgId: orgA, userId, amountCents: 200, promoCode: "welcome" });

    ssMocks.getStats.mockResolvedValue({
      total_paid_cents: "5000.0000000000",
      accounts_with_payment_method: 1,
      monthly_growth: [{ period: "2026-05-01", paid_cents: "5000.0000000000" }],
      weekly_growth: [{ period: "2026-05-11", paid_cents: "5000.0000000000" }],
    });

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body.monthly_growth.length).toBeGreaterThanOrEqual(1);
    for (const row of res.body.monthly_growth) {
      expect(row).toHaveProperty("period");
      expect(row).toHaveProperty("credited_cents");
      expect(row).toHaveProperty("revenue_cents");
    }

    const totalCredited = res.body.monthly_growth.reduce(
      (s: number, r: { credited_cents: string }) => s + parseFloat(r.credited_cents),
      0
    );
    const totalRevenue = res.body.monthly_growth.reduce(
      (s: number, r: { revenue_cents: string }) => s + parseFloat(r.revenue_cents),
      0
    );
    expect(totalCredited).toBe(5200);
    expect(totalRevenue).toBe(5000);
  });

  it("returns 502 when stripe-service stats unavailable", async () => {
    ssMocks.getStats.mockRejectedValue(new Error("SS down"));

    const res = await request(app).get("/public/stats/billing");
    expect(res.status).toBe(502);
  });
});
