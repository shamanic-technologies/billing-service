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
      expect(res.body.creditBalanceCents).toBe(200);
      expect(res.body.hasPaymentMethod).toBe(false);
      expect(res.body.hasAutoReload).toBe(false);
      expect(res.body).not.toHaveProperty("billingMode");
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
          "x-workflow-slug": "onboarding-flow",
        });

      expect(res.status).toBe(200);
      expect(stripeMocks.createCustomer).toHaveBeenCalledWith(
        orgId,
        userId,
        undefined,
        {
          "x-campaign-id": "camp_42",
          "x-brand-id": "brand_7",
          "x-workflow-slug": "onboarding-flow",
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
      });

      const res = await request(app)
        .get("/v1/accounts/balance")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        balance_cents: 150,
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

  describe("PATCH /v1/accounts/auto-reload", () => {
    it("enables auto-reload when payment method exists", async () => {
      await insertTestAccount({
        orgId,
        stripePaymentMethodId: "pm_123",
      });

      const res = await request(app)
        .patch("/v1/accounts/auto-reload")
        .set(getAuthHeaders(orgId))
        .send({
          reload_amount_cents: 5000,
          reload_threshold_cents: 1000,
        });

      expect(res.status).toBe(200);
      expect(res.body.reloadAmountCents).toBe(5000);
      expect(res.body.reloadThresholdCents).toBe(1000);
      expect(res.body.hasAutoReload).toBe(true);
    });

    it("defaults reload_threshold_cents to 200 when omitted", async () => {
      await insertTestAccount({
        orgId,
        stripePaymentMethodId: "pm_123",
      });

      const res = await request(app)
        .patch("/v1/accounts/auto-reload")
        .set(getAuthHeaders(orgId))
        .send({ reload_amount_cents: 3000 });

      expect(res.status).toBe(200);
      expect(res.body.reloadThresholdCents).toBe(200);
    });

    it("allows reload_threshold_cents of 0", async () => {
      await insertTestAccount({
        orgId,
        stripePaymentMethodId: "pm_123",
      });

      const res = await request(app)
        .patch("/v1/accounts/auto-reload")
        .set(getAuthHeaders(orgId))
        .send({
          reload_amount_cents: 5000,
          reload_threshold_cents: 0,
        });

      expect(res.status).toBe(200);
      expect(res.body.reloadThresholdCents).toBe(0);
    });

    it("rejects negative reload_threshold_cents", async () => {
      await insertTestAccount({
        orgId,
        stripePaymentMethodId: "pm_123",
      });

      const res = await request(app)
        .patch("/v1/accounts/auto-reload")
        .set(getAuthHeaders(orgId))
        .send({
          reload_amount_cents: 5000,
          reload_threshold_cents: -100,
        });

      expect(res.status).toBe(400);
    });

    it("requires payment method", async () => {
      await insertTestAccount({ orgId });

      const res = await request(app)
        .patch("/v1/accounts/auto-reload")
        .set(getAuthHeaders(orgId))
        .send({ reload_amount_cents: 2000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Payment method required");
    });

    it("requires reload_amount_cents", async () => {
      await insertTestAccount({
        orgId,
        stripePaymentMethodId: "pm_123",
      });

      const res = await request(app)
        .patch("/v1/accounts/auto-reload")
        .set(getAuthHeaders(orgId))
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown org", async () => {
      const res = await request(app)
        .patch("/v1/accounts/auto-reload")
        .set(getAuthHeaders("00000000-0000-0000-0000-999999999999"))
        .send({ reload_amount_cents: 2000 });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /v1/accounts/auto-reload", () => {
    it("disables auto-reload", async () => {
      await insertTestAccount({
        orgId,
        stripePaymentMethodId: "pm_123",
        reloadAmountCents: 5000,
        reloadThresholdCents: 1000,
      });

      const res = await request(app)
        .delete("/v1/accounts/auto-reload")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.reloadAmountCents).toBeNull();
      expect(res.body.reloadThresholdCents).toBeNull();
      expect(res.body.hasAutoReload).toBe(false);
    });

    it("returns 404 for unknown org", async () => {
      const res = await request(app)
        .delete("/v1/accounts/auto-reload")
        .set(getAuthHeaders("00000000-0000-0000-0000-999999999999"));

      expect(res.status).toBe(404);
    });
  });
});
