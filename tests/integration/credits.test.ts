import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

describe("Credits deduction endpoint", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  const userId = "00000000-0000-0000-0000-000000000099";
  let stripeMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    stripeMocks = setupStripeMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
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
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      balance_cents: 195,
      depleted: false,
    });
  });

  it("allows negative balance when insufficient", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 3,
    });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({
        amount_cents: 5,
        description: "test deduction",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.depleted).toBe(true);
    expect(res.body.balance_cents).toBe(-2);
  });

  it("auto-reloads when insufficient balance and auto-reload configured", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
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
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Balance should be: 3 (original) + 2000 (reload) - 5 (deduction) = 1998
    expect(res.body.balance_cents).toBe(1998);
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalledWith(
      orgId,
      userId,
      "cus_123",
      "pm_123",
      2000,
      "Auto-reload (1x)",
      {}
    );
  });

  it("charges multiple reloads when amount exceeds single reload", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 200,
      reloadAmountCents: 1000, // $10 reload unit
      reloadThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({
        amount_cents: 3700, // $37 deduction, need $35 more → 4x $10 = $40
        description: "large deduction",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Balance: 200 + 4000 (4x reload) - 3700 = 500
    expect(res.body.balance_cents).toBe(500);
    expect(res.body.depleted).toBe(false);
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalledWith(
      orgId,
      userId,
      "cus_123",
      "pm_123",
      4000,
      "Auto-reload (4x)",
      {}
    );
  });

  it("deducts into negative when auto-reload fails", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
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
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.depleted).toBe(true);
    expect(res.body.balance_cents).toBe(-2);
  });

  it("auto-creates account for unknown org and deducts from trial balance", async () => {
    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders("00000000-0000-0000-0000-999999999999"))
      .send({
        amount_cents: 5,
        description: "test",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Auto-created with 200 cents ($2), then deducted 5
    expect(res.body.balance_cents).toBe(195);
  });

  it("validates request body", async () => {
    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({ amount_cents: -5 });

    expect(res.status).toBe(400);
  });

  it("passes userId from header to Stripe metadata", async () => {
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
        description: "test deduction",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(stripeMocks.createBalanceTransaction).toHaveBeenCalledWith(
      orgId,
      userId,
      "cus_123",
      5,
      "test deduction",
      { user_id: userId },
      {}
    );
  });

  it("forwards workflow headers to Stripe calls", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 200,
    });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set({
        ...getAuthHeaders(orgId),
        "x-campaign-id": "camp_42",
        "x-brand-id": "brand_7",
        "x-workflow-slug": "outreach-flow",
      })
      .send({
        amount_cents: 5,
        description: "test deduction",
      });

    expect(res.status).toBe(200);
    expect(stripeMocks.createBalanceTransaction).toHaveBeenCalledWith(
      orgId,
      userId,
      "cus_123",
      5,
      "test deduction",
      { user_id: userId },
      {
        "x-campaign-id": "camp_42",
        "x-brand-id": "brand_7",
        "x-workflow-slug": "outreach-flow",
      }
    );
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
    };

    const res1 = await request(app).post("/v1/credits/deduct").set(headers).send(body);
    expect(res1.body.balance_cents).toBe(90);

    const res2 = await request(app).post("/v1/credits/deduct").set(headers).send(body);
    expect(res2.body.balance_cents).toBe(80);

    const res3 = await request(app).post("/v1/credits/deduct").set(headers).send(body);
    expect(res3.body.balance_cents).toBe(70);
  });
});

describe("Credits authorize endpoint", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  const userId = "00000000-0000-0000-0000-000000000099";
  let stripeMocks: ReturnType<typeof setupStripeMocks>;

  const authorizeBody = {
    items: [
      { costName: "anthropic-sonnet-4-5-tokens-input", quantity: 1000 },
      { costName: "anthropic-sonnet-4-5-tokens-output", quantity: 500 },
    ],
    description: "content-generation — claude-sonnet-4-5",
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    stripeMocks = setupStripeMocks();
    await cleanTestData();

    // Mock costs-client to return deterministic prices
    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue(100);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("returns sufficient: true when balance covers required amount", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 500,
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sufficient: true,
      balance_cents: 500,
      required_cents: 100,
    });
  });

  it("returns sufficient: false when balance is insufficient (no auto-reload)", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 50,
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sufficient: false,
      balance_cents: 50,
      required_cents: 100,
    });
  });

  it("auto-reloads and returns sufficient after reload", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 50,
      reloadAmountCents: 2000,
      reloadThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sufficient: true,
      balance_cents: 2050,
      required_cents: 100,
    });
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalledWith(
      orgId,
      userId,
      "cus_123",
      "pm_123",
      2000,
      "Auto-reload (1x)",
      {}
    );
  });

  it("charges multiple reloads when required amount exceeds single reload", async () => {
    // Override costs-client to return a large required amount
    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue(3700);

    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 200,
      reloadAmountCents: 1000, // $10 reload unit
      reloadThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    // Need 3700, have 200 → deficit 3500 → ceil(3500/1000) = 4 → charge 4000
    expect(res.body).toEqual({
      sufficient: true,
      balance_cents: 4200, // 200 + 4000
      required_cents: 3700,
    });
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalledWith(
      orgId,
      userId,
      "cus_123",
      "pm_123",
      4000,
      "Auto-reload (4x)",
      {}
    );
  });

  it("returns sufficient: false when auto-reload fails", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 50,
      reloadAmountCents: 2000,
      reloadThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    stripeMocks.chargePaymentMethod.mockRejectedValue(
      new Error("Card declined")
    );

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sufficient: false,
      balance_cents: 50,
      required_cents: 100,
    });
  });

  it("auto-creates account for unknown org and authorizes from trial balance", async () => {
    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders("00000000-0000-0000-0000-999999999999"))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);
    // Auto-created with 200 cents ($2), costs-service mock returns 100
    expect(res.body.balance_cents).toBe(200);
  });

  it("validates request body — rejects empty items", async () => {
    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send({ items: [] });

    expect(res.status).toBe(400);
  });

  it("returns 502 when costs-service is unavailable", async () => {
    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockRejectedValue(
      new Error("COSTS_SERVICE not configured")
    );

    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 500,
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("costs-service");
  });
});
