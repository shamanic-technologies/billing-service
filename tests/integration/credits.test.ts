import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

describe("Credits deduction endpoint", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  const userId = "00000000-0000-0000-0000-000000000002";
  let stripeMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    stripeMocks = setupStripeMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("deducts credits successfully", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 200,
    });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({
        amount_cents: 5,
        description: "anthropic-sonnet-4.5 tokens",
        app_id: "mcpfactory",
        user_id: userId,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      balance_cents: 195,
      billing_mode: "trial",
      depleted: false,
    });
  });

  it("returns depleted when insufficient balance (trial)", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 3,
      billingMode: "trial",
    });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({
        amount_cents: 5,
        description: "test deduction",
        app_id: "testapp",
        user_id: userId,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.depleted).toBe(true);
    expect(res.body.balance_cents).toBe(3);
  });

  it("bypasses deduction for BYOK mode", async () => {
    await insertTestAccount({
      orgId,
      billingMode: "byok",
      creditBalanceCents: 0,
    });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({
        amount_cents: 100,
        description: "should not deduct",
        app_id: "testapp",
        user_id: userId,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      balance_cents: null,
      billing_mode: "byok",
      depleted: false,
    });
  });

  it("auto-reloads for PAYG when insufficient balance", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      billingMode: "payg",
      creditBalanceCents: 3,
      reloadAmountCents: 2000,
      reloadThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({
        amount_cents: 5,
        description: "test deduction with reload",
        app_id: "testapp",
        user_id: userId,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Balance should be: 3 (original) + 2000 (reload) - 5 (deduction) = 1998
    expect(res.body.balance_cents).toBe(1998);
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalledWith(
      "cus_123",
      "pm_123",
      2000,
      "Auto-reload"
    );
  });

  it("returns depleted when PAYG auto-reload fails", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      billingMode: "payg",
      creditBalanceCents: 3,
      reloadAmountCents: 2000,
      reloadThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    stripeMocks.chargePaymentMethod.mockRejectedValue(
      new Error("Card declined")
    );

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({
        amount_cents: 5,
        description: "test deduction",
        app_id: "testapp",
        user_id: userId,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.depleted).toBe(true);
  });

  it("returns 404 for unknown org", async () => {
    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders("00000000-0000-0000-0000-999999999999"))
      .send({
        amount_cents: 5,
        description: "test",
        app_id: "testapp",
        user_id: userId,
      });

    expect(res.status).toBe(404);
  });

  it("validates request body", async () => {
    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({ amount_cents: -5 });

    expect(res.status).toBe(400);
  });

  it("handles multiple sequential deductions correctly", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 100,
    });

    const headers = getAuthHeaders(orgId);
    const body = {
      amount_cents: 10,
      description: "test",
      app_id: "testapp",
      user_id: userId,
    };

    const res1 = await request(app).post("/v1/credits/deduct").set(headers).send(body);
    expect(res1.body.balance_cents).toBe(90);

    const res2 = await request(app).post("/v1/credits/deduct").set(headers).send(body);
    expect(res2.body.balance_cents).toBe(80);

    const res3 = await request(app).post("/v1/credits/deduct").set(headers).send(body);
    expect(res3.body.balance_cents).toBe(70);
  });
});
