import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { transactions } from "../../src/db/schema.js";

describe("GET /public/stats/billing", () => {
  const app = createTestApp();
  const orgA = "00000000-0000-0000-0000-000000000001";
  const orgB = "00000000-0000-0000-0000-000000000002";
  const userId = "00000000-0000-0000-0000-000000000099";

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("returns zeros and empty growth when no data exists", async () => {
    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalAccounts: 0,
      accountsWithPaymentMethod: 0,
      totalCreditBalanceCents: "0.0000000000",
      totalCreditedCents: "0.0000000000",
      totalConsumedCents: "0.0000000000",
      monthlyGrowth: [],
      weeklyGrowth: [],
    });
  });

  it("does not require authentication", async () => {
    const res = await request(app).get("/public/stats/billing");
    expect(res.status).toBe(200);
  });

  it("aggregates across multiple orgs", async () => {
    await insertTestAccount({
      orgId: orgA,
      creditBalanceCents: 5000,
      stripePaymentMethodId: "pm_123",
    });
    await insertTestAccount({
      orgId: orgB,
      creditBalanceCents: 3000,
      stripePaymentMethodId: null,
    });

    await db.insert(transactions).values([
      {
        orgId: orgA,
        userId,
        type: "credit",
        status: "confirmed",
        amountCents: 10000,
        source: "reload",
        description: "reload",
      },
      {
        orgId: orgB,
        userId,
        type: "credit",
        status: "confirmed",
        amountCents: 5000,
        source: "reload",
        description: "reload",
      },
      {
        orgId: orgA,
        userId,
        type: "debit",
        status: "confirmed",
        amountCents: 2000,
        source: "charge",
        description: "usage",
      },
      {
        orgId: orgA,
        userId,
        type: "debit",
        status: "pending",
        amountCents: 9999,
        source: "charge",
        description: "pending charge — included in consumed",
      },
      {
        orgId: orgB,
        userId,
        type: "credit",
        status: "cancelled",
        amountCents: 9999,
        source: "reload",
        description: "should be excluded — cancelled",
      },
    ]);

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body.totalAccounts).toBe(2);
    expect(res.body.accountsWithPaymentMethod).toBe(1);
    expect(res.body.totalCreditBalanceCents).toBe("8000.0000000000");
    expect(res.body.totalCreditedCents).toBe("15000.0000000000");
    expect(res.body.totalConsumedCents).toBe("11999.0000000000"); // 2000 confirmed + 9999 pending
  });

  it("returns monthly and weekly growth with credited, consumed, and revenue", async () => {
    await insertTestAccount({ orgId: orgA, creditBalanceCents: 1000 });

    await db.insert(transactions).values([
      {
        orgId: orgA,
        userId,
        type: "credit",
        status: "confirmed",
        amountCents: 5000,
        source: "reload",
        description: "reload — real payment",
      },
      {
        orgId: orgA,
        userId,
        type: "credit",
        status: "confirmed",
        amountCents: 200,
        source: "welcome",
        description: "welcome — not revenue",
      },
      {
        orgId: orgA,
        userId,
        type: "debit",
        status: "confirmed",
        amountCents: 300,
        source: "charge",
        description: "usage",
      },
    ]);

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);

    // Should have growth arrays
    expect(res.body.monthlyGrowth).toBeInstanceOf(Array);
    expect(res.body.monthlyGrowth.length).toBeGreaterThanOrEqual(1);
    expect(res.body.weeklyGrowth).toBeInstanceOf(Array);
    expect(res.body.weeklyGrowth.length).toBeGreaterThanOrEqual(1);

    // Sum across all periods should match totals (parse string-cents to number for sum)
    const totalMonthlyCredited = res.body.monthlyGrowth.reduce(
      (sum: number, r: { credited_cents: string }) => sum + parseFloat(r.credited_cents),
      0
    );
    const totalMonthlyConsumed = res.body.monthlyGrowth.reduce(
      (sum: number, r: { consumed_cents: string }) => sum + parseFloat(r.consumed_cents),
      0
    );
    const totalMonthlyRevenue = res.body.monthlyGrowth.reduce(
      (sum: number, r: { revenue_cents: string }) => sum + parseFloat(r.revenue_cents),
      0
    );

    expect(totalMonthlyCredited).toBe(5200); // 5000 reload + 200 welcome
    expect(totalMonthlyConsumed).toBe(300);
    expect(totalMonthlyRevenue).toBe(5000); // only reload is revenue

    // Each row should have the expected shape
    for (const row of res.body.monthlyGrowth) {
      expect(row).toHaveProperty("period");
      expect(row).toHaveProperty("credited_cents");
      expect(row).toHaveProperty("consumed_cents");
      expect(row).toHaveProperty("revenue_cents");
    }
  });

  // Regression: investor page was showing $1418 credited vs $870 real Stripe revenue because
  // provision_cancel and provision_adjust credit miroirs were summed into totalCreditedCents.
  // After the refactor, those sources no longer exist; only canonical credit sources count.
  it("totalCreditedCents only sums canonical credit sources (no accounting noise)", async () => {
    await insertTestAccount({ orgId: orgA, creditBalanceCents: 1000 });

    await db.insert(transactions).values([
      // Canonical credits — all counted.
      {
        orgId: orgA,
        userId,
        type: "credit",
        status: "confirmed",
        amountCents: 1000,
        source: "reload",
        description: "real Stripe top-up",
      },
      {
        orgId: orgA,
        userId,
        type: "credit",
        status: "confirmed",
        amountCents: 200,
        source: "welcome",
        description: "trial credit",
      },
      {
        orgId: orgA,
        userId,
        type: "credit",
        status: "confirmed",
        amountCents: 50,
        source: "promo",
        description: "promo redemption",
      },
      // Cancelled credit — excluded by status filter.
      {
        orgId: orgA,
        userId,
        type: "credit",
        status: "cancelled",
        amountCents: 9999,
        source: "reload",
        description: "failed reload — must not count",
      },
    ]);

    const res = await request(app).get("/public/stats/billing");
    expect(res.status).toBe(200);
    expect(res.body.totalCreditedCents).toBe("1250.0000000000"); // 1000 + 200 + 50
  });

  it("totalConsumedCents excludes cancelled charges", async () => {
    await insertTestAccount({ orgId: orgA, creditBalanceCents: 1000 });

    await db.insert(transactions).values([
      {
        orgId: orgA,
        userId,
        type: "debit",
        status: "confirmed",
        amountCents: 100,
        source: "charge",
        description: "confirmed usage",
      },
      {
        orgId: orgA,
        userId,
        type: "debit",
        status: "pending",
        amountCents: 50,
        source: "charge",
        description: "active hold",
      },
      {
        orgId: orgA,
        userId,
        type: "debit",
        status: "cancelled",
        amountCents: 999,
        source: "charge",
        description: "cancelled hold — must not count",
      },
    ]);

    const res = await request(app).get("/public/stats/billing");
    expect(res.status).toBe(200);
    expect(res.body.totalConsumedCents).toBe("150.0000000000");
  });
});
