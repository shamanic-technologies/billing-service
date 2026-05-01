import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { creditLedger } from "../../src/db/schema.js";

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
      totalCreditBalanceCents: 0,
      totalCreditedCents: 0,
      totalConsumedCents: 0,
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

    await db.insert(creditLedger).values([
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
        source: "deduct",
        description: "usage",
      },
      {
        orgId: orgA,
        userId,
        type: "debit",
        status: "pending",
        amountCents: 9999,
        source: "provision",
        description: "pending provision — included in consumed",
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
    expect(res.body.totalCreditBalanceCents).toBe(8000);
    expect(res.body.totalCreditedCents).toBe(15000);
    expect(res.body.totalConsumedCents).toBe(11999); // 2000 confirmed + 9999 pending
  });

  it("returns monthly and weekly growth with credited, consumed, and revenue", async () => {
    await insertTestAccount({ orgId: orgA, creditBalanceCents: 1000 });

    await db.insert(creditLedger).values([
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
        source: "deduct",
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

    // Sum across all periods should match totals
    const totalMonthlyCredited = res.body.monthlyGrowth.reduce(
      (sum: number, r: { credited_cents: number }) => sum + r.credited_cents,
      0
    );
    const totalMonthlyConsumed = res.body.monthlyGrowth.reduce(
      (sum: number, r: { consumed_cents: number }) => sum + r.consumed_cents,
      0
    );
    const totalMonthlyRevenue = res.body.monthlyGrowth.reduce(
      (sum: number, r: { revenue_cents: number }) => sum + r.revenue_cents,
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
});
