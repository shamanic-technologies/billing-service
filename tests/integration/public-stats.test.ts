import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { customerBalanceTransactions } from "../../src/db/schema.js";

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
      total_accounts: 0,
      accounts_with_payment_method: 0,
      total_balance_cents: "0.0000000000",
      total_credited_cents: "0.0000000000",
      monthly_growth: [],
      weekly_growth: [],
    });
    expect(res.body).not.toHaveProperty("totalConsumedCents");
    expect(res.body).not.toHaveProperty("totalCreditBalanceCents");
    expect(res.body).not.toHaveProperty("totalGrantsCents");
  });

  it("does not require authentication", async () => {
    const res = await request(app).get("/public/stats/billing");
    expect(res.status).toBe(200);
  });

  it("aggregates across multiple orgs", async () => {
    await insertTestAccount({
      orgId: orgA,
      balanceCents: 5000,
      stripePaymentMethodId: "pm_123",
    });
    await insertTestAccount({
      orgId: orgB,
      balanceCents: 3000,
      stripePaymentMethodId: null,
    });

    await db.insert(customerBalanceTransactions).values([
      {
        orgId: orgA,
        userId,
        type: "payment",
        status: "succeeded",
        amountCents: "-10000.0000000000",
        description: "topup",
      },
      {
        orgId: orgB,
        userId,
        type: "payment",
        status: "succeeded",
        amountCents: "-5000.0000000000",
        description: "topup",
      },
      {
        orgId: orgB,
        userId,
        type: "payment",
        status: "canceled",
        amountCents: "-9999.0000000000",
        description: "should be excluded — canceled",
      },
    ]);

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body.total_accounts).toBe(2);
    expect(res.body.accounts_with_payment_method).toBe(1);
    expect(res.body.total_balance_cents).toBe("8000.0000000000");
    expect(res.body.total_credited_cents).toBe("15000.0000000000");
    expect(res.body).not.toHaveProperty("totalConsumedCents");
  });

  it("returns monthly and weekly growth with credited and revenue", async () => {
    await insertTestAccount({ orgId: orgA, balanceCents: 1000 });

    await db.insert(customerBalanceTransactions).values([
      {
        orgId: orgA,
        userId,
        type: "payment",
        status: "succeeded",
        amountCents: "-5000.0000000000",
        description: "topup — real payment",
      },
      {
        orgId: orgA,
        userId,
        type: "gift",
        status: "succeeded",
        amountCents: "-200.0000000000",
        description: "welcome — not revenue",
      },
    ]);

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);

    expect(res.body.monthly_growth).toBeInstanceOf(Array);
    expect(res.body.monthly_growth.length).toBeGreaterThanOrEqual(1);
    expect(res.body.weekly_growth).toBeInstanceOf(Array);
    expect(res.body.weekly_growth.length).toBeGreaterThanOrEqual(1);

    const totalMonthlyCredited = res.body.monthly_growth.reduce(
      (sum: number, r: { credited_cents: string }) => sum + parseFloat(r.credited_cents),
      0
    );
    const totalMonthlyRevenue = res.body.monthly_growth.reduce(
      (sum: number, r: { revenue_cents: string }) => sum + parseFloat(r.revenue_cents),
      0
    );

    expect(totalMonthlyCredited).toBe(5200); // 5000 payment + 200 gift
    expect(totalMonthlyRevenue).toBe(5000); // only payment is revenue

    for (const row of res.body.monthly_growth) {
      expect(row).toHaveProperty("period");
      expect(row).toHaveProperty("credited_cents");
      expect(row).toHaveProperty("revenue_cents");
      expect(row).not.toHaveProperty("consumed_cents");
    }
  });

  // Regression: investor page was showing inflated credited totals when canceled
  // and provision-adjust credit miroirs were summed. Post-v3, only succeeded
  // credit-direction rows (amount_cents < 0) count.
  it("total_credited_cents only sums succeeded credit-type CBTs", async () => {
    await insertTestAccount({ orgId: orgA, balanceCents: 1000 });

    await db.insert(customerBalanceTransactions).values([
      // Canonical credits — all counted.
      {
        orgId: orgA,
        userId,
        type: "payment",
        status: "succeeded",
        amountCents: "-1000.0000000000",
        description: "real Stripe top-up",
      },
      {
        orgId: orgA,
        userId,
        type: "gift",
        status: "succeeded",
        amountCents: "-200.0000000000",
        description: "trial gift",
      },
      {
        orgId: orgA,
        userId,
        type: "promo",
        status: "succeeded",
        amountCents: "-50.0000000000",
        description: "promo redemption",
      },
      // Canceled credit — excluded by status filter.
      {
        orgId: orgA,
        userId,
        type: "payment",
        status: "canceled",
        amountCents: "-9999.0000000000",
        description: "failed topup — must not count",
      },
    ]);

    const res = await request(app).get("/public/stats/billing");
    expect(res.status).toBe(200);
    expect(res.body.total_credited_cents).toBe("1250.0000000000"); // 1000 + 200 + 50
  });
});
