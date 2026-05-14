import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { db } from "../../src/db/index.js";
import { transactions } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks, createStripeAuthError } from "../helpers/mock-stripe.js";

describe("Accounts endpoints", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  const userId = "00000000-0000-0000-0000-000000000099";
  let stripeMocks: ReturnType<typeof setupStripeMocks>;
  let fetchRunsOrgUsageTotalSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    stripeMocks = setupStripeMocks();
    await cleanTestData();

    const runsClient = await import("../../src/lib/runs-client.js");
    fetchRunsOrgUsageTotalSpy = vi.fn().mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-05-13T00:00:00.000Z",
    });
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(
      fetchRunsOrgUsageTotalSpy
    );
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
      expect(res.body.grantsCents).toBe("200.0000000000");
      expect(res.body.runsSpentCents).toBe("0.0000000000");
      expect(res.body.availableCents).toBe("200.0000000000");
      expect(res.body).not.toHaveProperty("creditBalanceCents");
      expect(res.body.hasPaymentMethod).toBe(false);
      expect(res.body.hasAutoReload).toBe(false);
      expect(res.body).not.toHaveProperty("billingMode");
      expect(stripeMocks.createCustomer).toHaveBeenCalledWith(
        orgId,
        userId,
        undefined,
        {}
      );
      expect(stripeMocks.createBalanceTransaction).not.toHaveBeenCalled();
    });

    it("subtracts runs-service spent_cents to compute availableCents", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_existing",
        creditBalanceCents: 150,
      });
      fetchRunsOrgUsageTotalSpy.mockResolvedValue({
        org_id: orgId,
        spent_cents: "25.0000000000",
        as_of: "2026-05-13T00:00:00.000Z",
      });

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.grantsCents).toBe("150.0000000000");
      expect(res.body.runsSpentCents).toBe("25.0000000000");
      expect(res.body.availableCents).toBe("125.0000000000");
    });

    it("returns negative availableCents when runs spent exceeds grants", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_existing",
        creditBalanceCents: 75,
      });
      fetchRunsOrgUsageTotalSpy.mockResolvedValue({
        org_id: orgId,
        spent_cents: "383.0000000000",
        as_of: "2026-05-13T00:00:00.000Z",
      });

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.availableCents).toBe("-308.0000000000");
    });

    it("returns 502 when runs-service total is unavailable", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_existing",
        creditBalanceCents: 150,
      });
      fetchRunsOrgUsageTotalSpy.mockRejectedValue(
        new Error("runs-service down")
      );

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(502);
      expect(res.body.error).toBe(
        "Failed to fetch usage total from runs-service"
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
      expect(res.body.grantsCents).toBe("150.0000000000");
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
    it("returns granted credits minus runs-service spent total", async () => {
      await insertTestAccount({
        orgId,
        creditBalanceCents: 150,
      });
      fetchRunsOrgUsageTotalSpy.mockResolvedValue({
        org_id: orgId,
        spent_cents: "25.0000000000",
        as_of: "2026-05-13T00:00:00.000Z",
      });

      const res = await request(app)
        .get("/v1/accounts/balance")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        balance_cents: "125.0000000000",
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

    it("returns 502 when runs-service total is unavailable", async () => {
      await insertTestAccount({ orgId, creditBalanceCents: 150 });
      fetchRunsOrgUsageTotalSpy.mockRejectedValue(new Error("runs-service down"));

      const res = await request(app)
        .get("/v1/accounts/balance")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(502);
      expect(res.body.error).toBe("Failed to fetch usage total from runs-service");
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

    it("returns local credit grant history", async () => {
      await insertTestAccount({ orgId, stripeCustomerId: "cus_123" });
      await db.insert(transactions).values([
        {
          orgId,
          userId,
          type: "credit",
          amountCents: "200.0000000000",
          status: "confirmed",
          source: "welcome",
          description: "Trial credit: $2.00",
          createdAt: new Date("2026-05-13T00:00:00.000Z"),
        },
        {
          orgId,
          userId,
          type: "credit",
          amountCents: "500.0000000000",
          status: "confirmed",
          source: "reload",
          description: "Auto-reload credit ($5.00)",
          createdAt: new Date("2026-05-13T00:01:00.000Z"),
        },
      ]);

      const res = await request(app)
        .get("/v1/accounts/transactions")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.transactions).toHaveLength(2);
      expect(res.body.transactions.map((txn: { type: string }) => txn.type)).toEqual([
        "reload",
        "credit",
      ]);
      expect(stripeMocks.listBalanceTransactions).not.toHaveBeenCalled();
    });

    it("excludes legacy source='charge' rows from response", async () => {
      await insertTestAccount({ orgId, stripeCustomerId: "cus_123" });
      await db.insert(transactions).values([
        {
          orgId,
          userId,
          type: "credit",
          amountCents: "200.0000000000",
          status: "confirmed",
          source: "welcome",
          description: "welcome grant",
          createdAt: new Date("2026-05-13T00:00:00.000Z"),
        },
        {
          orgId,
          userId,
          type: "debit",
          amountCents: "50.0000000000",
          status: "confirmed",
          source: "charge",
          description: "legacy pre-#104 charge row",
          createdAt: new Date("2026-05-13T00:01:00.000Z"),
        },
        {
          orgId,
          userId,
          type: "debit",
          amountCents: "25.0000000000",
          status: "pending",
          source: "charge",
          description: "legacy pre-#104 pending charge",
          createdAt: new Date("2026-05-13T00:02:00.000Z"),
        },
      ]);

      const res = await request(app)
        .get("/v1/accounts/transactions")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.transactions).toHaveLength(1);
      expect(res.body.transactions[0].description).toBe("welcome grant");
      expect(
        res.body.transactions.some(
          (txn: { type: string }) => txn.type === "deduction"
        )
      ).toBe(false);
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
