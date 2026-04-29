import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { creditProvisions } from "../../src/db/schema.js";

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

  it("returns zeros when no data exists", async () => {
    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalAccounts: 0,
      accountsWithPaymentMethod: 0,
      totalCreditBalanceCents: 0,
      totalCreditedCents: 0,
      totalConsumedCents: 0,
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

    await db.insert(creditProvisions).values([
      {
        orgId: orgA,
        userId,
        type: "debit",
        status: "confirmed",
        amountCents: 2000,
        description: "usage",
      },
      {
        orgId: orgA,
        userId,
        type: "debit",
        status: "pending",
        amountCents: 9999,
        description: "should be excluded — pending",
      },
      {
        orgId: orgB,
        userId,
        type: "credit",
        status: "cancelled",
        amountCents: 9999,
        description: "should be excluded — cancelled",
      },
    ]);

    const res = await request(app).get("/public/stats/billing");

    // totalCreditedCents = balance + consumed = 8000 + 2000 = 10000
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalAccounts: 2,
      accountsWithPaymentMethod: 1,
      totalCreditBalanceCents: 8000,
      totalCreditedCents: 10000,
      totalConsumedCents: 2000,
    });
  });

  it("includes credits not tracked in credit_provisions (welcome, promo, webhook reload)", async () => {
    // Balances include welcome credits ($2), promo ($10), and a Stripe reload ($20)
    // but only the reload created a credit_provision row.
    // totalCreditedCents must still reflect ALL credits via the balance equation.
    await insertTestAccount({
      orgId: orgA,
      creditBalanceCents: 30000,
    });

    await db.insert(creditProvisions).values([
      {
        orgId: orgA,
        userId,
        type: "credit",
        status: "confirmed",
        amountCents: 20000,
        description: "reload — only tracked credit source",
      },
      {
        orgId: orgA,
        userId,
        type: "debit",
        status: "confirmed",
        amountCents: 2000,
        description: "usage",
      },
    ]);

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    // totalCreditedCents = balance + consumed = 30000 + 2000 = 32000
    // NOT 20000 (which would miss the $120 from welcome/promo)
    expect(res.body.totalCreditedCents).toBe(32000);
    expect(res.body.totalConsumedCents).toBe(2000);
    expect(res.body.totalCreditBalanceCents).toBe(30000);
  });
});
