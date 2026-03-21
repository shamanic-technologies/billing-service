import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks, createStripeAuthError } from "../helpers/mock-stripe.js";

describe("Accounts endpoints", () => {
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
    await closeDb();
  });

  describe("GET /v1/accounts", () => {
    it("auto-creates a billing account with $2 trial credit", async () => {
      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.orgId).toBe(orgId);
      expect(res.body.billingMode).toBe("trial");
      expect(res.body.creditBalanceCents).toBe(200);
      expect(res.body.hasPaymentMethod).toBe(false);
      expect(res.body).not.toHaveProperty("appId");
      expect(stripeMocks.createCustomer).toHaveBeenCalledWith(
        orgId,
        userId,
        undefined,
        {}
      );
      expect(stripeMocks.createBalanceTransaction).toHaveBeenCalledWith(
        orgId,
        userId,
        "cus_mock123",
        -200,
        "Trial credit: $2.00",
        undefined,
        {}
      );
    });

    it("forwards workflow headers to downstream calls", async () => {
      const res = await request(app)
        .get("/v1/accounts")
        .set({
          ...getAuthHeaders(orgId),
          "x-campaign-id": "camp_42",
          "x-brand-id": "brand_7",
          "x-workflow-name": "onboarding-flow",
        });

      expect(res.status).toBe(200);
      expect(stripeMocks.createCustomer).toHaveBeenCalledWith(
        orgId,
        userId,
        undefined,
        {
          "x-campaign-id": "camp_42",
          "x-brand-id": "brand_7",
          "x-workflow-name": "onboarding-flow",
        }
      );
    });

    it("returns existing account without creating a new one", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_existing",
        creditBalanceCents: 150,
      });

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.creditBalanceCents).toBe(150);
      expect(stripeMocks.createCustomer).not.toHaveBeenCalled();
    });

    it("returns 401 without API key", async () => {
      const res = await request(app)
        .get("/v1/accounts")
        .set({ "x-org-id": orgId, "x-user-id": userId });

      expect(res.status).toBe(401);
    });

    it("returns 400 without x-org-id header", async () => {
      const res = await request(app)
        .get("/v1/accounts")
        .set({ "X-API-Key": "test-api-key", "x-user-id": userId });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("x-org-id header is required");
    });

    it("returns 400 without x-user-id header", async () => {
      const res = await request(app)
        .get("/v1/accounts")
        .set({ "X-API-Key": "test-api-key", "x-org-id": orgId });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("x-user-id header is required");
    });

    it("returns 400 without x-run-id header", async () => {
      const res = await request(app)
        .get("/v1/accounts")
        .set({
          "X-API-Key": "test-api-key",
          "x-org-id": orgId,
          "x-user-id": userId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("x-run-id header is required");
    });

    it("returns 502 when Stripe key is expired", async () => {
      stripeMocks.createCustomer.mockRejectedValue(
        createStripeAuthError("Expired API Key provided")
      );

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(502);
      expect(res.body.error).toBe("Payment provider authentication failed");
    });
  });

  describe("GET /v1/accounts/balance", () => {
    it("returns cached balance", async () => {
      await insertTestAccount({
        orgId,
        creditBalanceCents: 150,
        billingMode: "trial",
      });

      const res = await request(app)
        .get("/v1/accounts/balance")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        balance_cents: 150,
        billing_mode: "trial",
        depleted: false,
      });
    });

    it("marks depleted when balance is 0", async () => {
      await insertTestAccount({
        orgId,
        creditBalanceCents: 0,
      });

      const res = await request(app)
        .get("/v1/accounts/balance")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.depleted).toBe(true);
    });

    it("returns 404 for unknown org", async () => {
      const res = await request(app)
        .get("/v1/accounts/balance")
        .set(getAuthHeaders("00000000-0000-0000-0000-999999999999"));

      expect(res.status).toBe(404);
    });
  });

  describe("GET /v1/accounts/transactions", () => {
    it("returns empty list when no Stripe customer", async () => {
      await insertTestAccount({ orgId, stripeCustomerId: undefined });

      const res = await request(app)
        .get("/v1/accounts/transactions")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ transactions: [], has_more: false });
    });

    it("returns transactions from Stripe", async () => {
      await insertTestAccount({ orgId, stripeCustomerId: "cus_123" });

      stripeMocks.listBalanceTransactions.mockResolvedValue({
        data: [
          {
            id: "cbtxn_1",
            amount: 5,
            description: "anthropic-sonnet-4.5 tokens",
            created: Math.floor(Date.now() / 1000),
          },
          {
            id: "cbtxn_2",
            amount: -200,
            description: "Trial credit: $2.00",
            created: Math.floor(Date.now() / 1000),
          },
        ],
        has_more: false,
      });

      const res = await request(app)
        .get("/v1/accounts/transactions")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.transactions).toHaveLength(2);
      expect(res.body.transactions[0].type).toBe("deduction");
      expect(res.body.transactions[1].type).toBe("credit");
    });

    it("returns 502 when Stripe key is expired", async () => {
      await insertTestAccount({ orgId, stripeCustomerId: "cus_123" });
      stripeMocks.listBalanceTransactions.mockRejectedValue(
        createStripeAuthError("Expired API Key provided")
      );

      const res = await request(app)
        .get("/v1/accounts/transactions")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(502);
      expect(res.body.error).toBe("Payment provider authentication failed");
    });
  });

  describe("PATCH /v1/accounts/mode", () => {
    it("switches from trial to byok", async () => {
      await insertTestAccount({ orgId, billingMode: "trial" });

      const res = await request(app)
        .patch("/v1/accounts/mode")
        .set(getAuthHeaders(orgId))
        .send({ mode: "byok" });

      expect(res.status).toBe(200);
      expect(res.body.billingMode).toBe("byok");
    });

    it("requires payment method for payg", async () => {
      await insertTestAccount({ orgId, billingMode: "trial" });

      const res = await request(app)
        .patch("/v1/accounts/mode")
        .set(getAuthHeaders(orgId))
        .send({ mode: "payg", reload_amount_cents: 2000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Payment method required");
    });

    it("switches to payg when payment method exists", async () => {
      await insertTestAccount({
        orgId,
        billingMode: "trial",
        stripePaymentMethodId: "pm_123",
      });

      const res = await request(app)
        .patch("/v1/accounts/mode")
        .set(getAuthHeaders(orgId))
        .send({ mode: "payg", reload_amount_cents: 2000 });

      expect(res.status).toBe(200);
      expect(res.body.billingMode).toBe("payg");
    });

    it("stores reload_threshold_cents when switching to payg", async () => {
      await insertTestAccount({
        orgId,
        billingMode: "trial",
        stripePaymentMethodId: "pm_123",
      });

      const res = await request(app)
        .patch("/v1/accounts/mode")
        .set(getAuthHeaders(orgId))
        .send({
          mode: "payg",
          reload_amount_cents: 5000,
          reload_threshold_cents: 1000,
        });

      expect(res.status).toBe(200);
      expect(res.body.billingMode).toBe("payg");
      expect(res.body.reloadAmountCents).toBe(5000);
      expect(res.body.reloadThresholdCents).toBe(1000);
    });

    it("allows reload_threshold_cents of 0", async () => {
      await insertTestAccount({
        orgId,
        billingMode: "trial",
        stripePaymentMethodId: "pm_123",
      });

      const res = await request(app)
        .patch("/v1/accounts/mode")
        .set(getAuthHeaders(orgId))
        .send({
          mode: "payg",
          reload_amount_cents: 5000,
          reload_threshold_cents: 0,
        });

      expect(res.status).toBe(200);
      expect(res.body.reloadThresholdCents).toBe(0);
    });

    it("rejects negative reload_threshold_cents", async () => {
      await insertTestAccount({
        orgId,
        billingMode: "trial",
        stripePaymentMethodId: "pm_123",
      });

      const res = await request(app)
        .patch("/v1/accounts/mode")
        .set(getAuthHeaders(orgId))
        .send({
          mode: "payg",
          reload_amount_cents: 5000,
          reload_threshold_cents: -100,
        });

      expect(res.status).toBe(400);
    });

    it("rejects switching back to trial", async () => {
      await insertTestAccount({ orgId, billingMode: "byok" });

      const res = await request(app)
        .patch("/v1/accounts/mode")
        .set(getAuthHeaders(orgId))
        .send({ mode: "trial" });

      expect(res.status).toBe(400);
    });
  });
});
