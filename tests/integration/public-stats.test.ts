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
        description: "should be excluded — pending",
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
    expect(res.body).toEqual({
      totalAccounts: 2,
      accountsWithPaymentMethod: 1,
      totalCreditBalanceCents: 8000,
      totalCreditedCents: 15000,
      totalConsumedCents: 2000,
    });
  });
});
