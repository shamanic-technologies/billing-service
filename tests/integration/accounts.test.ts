import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { db } from "../../src/db/index.js";
import { customerBalanceTransactions } from "../../src/db/schema.js";
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
    it("auto-creates a billing account with $2 trial gift", async () => {
      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.org_id).toBe(orgId);
      expect(res.body.balance_cents).toBe("200.0000000000");
      expect(res.body.usage_cents).toBe("0.0000000000");
      expect(res.body.available_cents).toBe("200.0000000000");
      expect(res.body).not.toHaveProperty("creditBalanceCents");
      expect(res.body).not.toHaveProperty("grantsCents");
      expect(res.body).not.toHaveProperty("runsSpentCents");
      expect(res.body).not.toHaveProperty("availableCents");
      expect(res.body.has_payment_method).toBe(false);
      expect(res.body.has_auto_topup).toBe(false);
      expect(stripeMocks.createCustomer).toHaveBeenCalledWith(
        orgId,
        userId,
        undefined,
        {}
      );
      expect(stripeMocks.createBalanceTransaction).not.toHaveBeenCalled();
    });

    it("subtracts runs-service spent_cents to compute available_cents", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_existing",
        balanceCents: 150,
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
      expect(res.body.balance_cents).toBe("150.0000000000");
      expect(res.body.usage_cents).toBe("25.0000000000");
      expect(res.body.available_cents).toBe("125.0000000000");
    });

    it("returns negative available_cents when runs spent exceeds balance", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_existing",
        balanceCents: 75,
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
      expect(res.body.available_cents).toBe("-308.0000000000");
    });

    it("returns 502 when runs-service total is unavailable", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_existing",
        balanceCents: 150,
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
        balanceCents: 150,
      });

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.balance_cents).toBe("150.0000000000");
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
    it("returns balance minus runs-service spent total as available_cents", async () => {
      await insertTestAccount({
        orgId,
        balanceCents: 150,
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
        available_cents: "125.0000000000",
        depleted: false,
      });
    });

    it("marks depleted when balance is 0", async () => {
      await insertTestAccount({
        orgId,
        balanceCents: 0,
      });

      const res = await request(app)
        .get("/v1/accounts/balance")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.depleted).toBe(true);
    });

    it("returns 502 when runs-service total is unavailable", async () => {
      await insertTestAccount({ orgId, balanceCents: 150 });
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

  describe("GET /v1/customer_balance_transactions", () => {
    it("returns empty list when no transactions exist", async () => {
      await insertTestAccount({ orgId, stripeCustomerId: undefined });

      const res = await request(app)
        .get("/v1/customer_balance_transactions")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.object).toBe("list");
      expect(res.body.data).toEqual([]);
      expect(res.body.has_more).toBe(false);
    });

    it("returns local customer balance transaction history", async () => {
      await insertTestAccount({ orgId, stripeCustomerId: "cus_123" });
      await db.insert(customerBalanceTransactions).values([
        {
          orgId,
          userId,
          type: "gift",
          amountCents: "-200.0000000000",
          status: "succeeded",
          description: "Trial gift: $2.00",
          createdAt: new Date("2026-05-13T00:00:00.000Z"),
        },
        {
          orgId,
          userId,
          type: "payment",
          amountCents: "-500.0000000000",
          status: "succeeded",
          description: "Auto-topup ($5.00)",
          createdAt: new Date("2026-05-13T00:01:00.000Z"),
        },
      ]);

      const res = await request(app)
        .get("/v1/customer_balance_transactions")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      // Newest first
      expect(res.body.data[0].type).toBe("payment");
      expect(res.body.data[0].amount_cents).toBe("-500.0000000000");
      expect(res.body.data[0].status).toBe("succeeded");
      expect(res.body.data[0].object).toBe("customer_balance_transaction");
      expect(res.body.data[1].type).toBe("gift");
      expect(res.body.data[1].amount_cents).toBe("-200.0000000000");
      expect(stripeMocks.listBalanceTransactions).not.toHaveBeenCalled();
    });

    it("excludes legacy type='usage_applied' rows from response", async () => {
      await insertTestAccount({ orgId, stripeCustomerId: "cus_123" });
      await db.insert(customerBalanceTransactions).values([
        {
          orgId,
          userId,
          type: "gift",
          amountCents: "-200.0000000000",
          status: "succeeded",
          description: "welcome gift",
          createdAt: new Date("2026-05-13T00:00:00.000Z"),
        },
        {
          orgId,
          userId,
          type: "usage_applied",
          amountCents: "50.0000000000",
          status: "succeeded",
          description: "legacy pre-#104 usage row",
          createdAt: new Date("2026-05-13T00:01:00.000Z"),
        },
        {
          orgId,
          userId,
          type: "usage_applied",
          amountCents: "25.0000000000",
          status: "requires_capture",
          description: "legacy pre-#104 pending usage",
          createdAt: new Date("2026-05-13T00:02:00.000Z"),
        },
      ]);

      const res = await request(app)
        .get("/v1/customer_balance_transactions")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].description).toBe("welcome gift");
      expect(
        res.body.data.some(
          (txn: { type: string }) => txn.type === "usage_applied"
        )
      ).toBe(false);
    });
  });

  describe("PATCH /v1/accounts/auto_topup", () => {
    it("enables auto-topup when payment method exists", async () => {
      await insertTestAccount({
        orgId,
        stripePaymentMethodId: "pm_123",
      });

      const res = await request(app)
        .patch("/v1/accounts/auto_topup")
        .set(getAuthHeaders(orgId))
        .send({
          topup_amount_cents: 5000,
          topup_threshold_cents: 1000,
        });

      expect(res.status).toBe(200);
      expect(res.body.topup_amount_cents).toBe(5000);
      expect(res.body.topup_threshold_cents).toBe(1000);
      expect(res.body.has_auto_topup).toBe(true);
    });

    it("defaults topup_threshold_cents to 200 when omitted", async () => {
      await insertTestAccount({
        orgId,
        stripePaymentMethodId: "pm_123",
      });

      const res = await request(app)
        .patch("/v1/accounts/auto_topup")
        .set(getAuthHeaders(orgId))
        .send({ topup_amount_cents: 3000 });

      expect(res.status).toBe(200);
      expect(res.body.topup_threshold_cents).toBe(200);
    });

    it("allows topup_threshold_cents of 0", async () => {
      await insertTestAccount({
        orgId,
        stripePaymentMethodId: "pm_123",
      });

      const res = await request(app)
        .patch("/v1/accounts/auto_topup")
        .set(getAuthHeaders(orgId))
        .send({
          topup_amount_cents: 5000,
          topup_threshold_cents: 0,
        });

      expect(res.status).toBe(200);
      expect(res.body.topup_threshold_cents).toBe(0);
    });

    it("rejects negative topup_threshold_cents", async () => {
      await insertTestAccount({
        orgId,
        stripePaymentMethodId: "pm_123",
      });

      const res = await request(app)
        .patch("/v1/accounts/auto_topup")
        .set(getAuthHeaders(orgId))
        .send({
          topup_amount_cents: 5000,
          topup_threshold_cents: -100,
        });

      expect(res.status).toBe(400);
    });

    it("requires payment method", async () => {
      await insertTestAccount({ orgId });

      const res = await request(app)
        .patch("/v1/accounts/auto_topup")
        .set(getAuthHeaders(orgId))
        .send({ topup_amount_cents: 2000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Payment method required");
    });

    it("requires topup_amount_cents", async () => {
      await insertTestAccount({
        orgId,
        stripePaymentMethodId: "pm_123",
      });

      const res = await request(app)
        .patch("/v1/accounts/auto_topup")
        .set(getAuthHeaders(orgId))
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown org", async () => {
      const res = await request(app)
        .patch("/v1/accounts/auto_topup")
        .set(getAuthHeaders("00000000-0000-0000-0000-999999999999"))
        .send({ topup_amount_cents: 2000 });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /v1/accounts/auto_topup", () => {
    it("disables auto-topup", async () => {
      await insertTestAccount({
        orgId,
        stripePaymentMethodId: "pm_123",
        topupAmountCents: 5000,
        topupThresholdCents: 1000,
      });

      const res = await request(app)
        .delete("/v1/accounts/auto_topup")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.topup_amount_cents).toBeNull();
      expect(res.body.topup_threshold_cents).toBeNull();
      expect(res.body.has_auto_topup).toBe(false);
    });

    it("returns 404 for unknown org", async () => {
      const res = await request(app)
        .delete("/v1/accounts/auto_topup")
        .set(getAuthHeaders("00000000-0000-0000-0000-999999999999"));

      expect(res.status).toBe(404);
    });
  });

  describe("removed v1 routes", () => {
    it("returns 404 for legacy /v1/accounts/transactions", async () => {
      const res = await request(app)
        .get("/v1/accounts/transactions")
        .set(getAuthHeaders(orgId));
      expect(res.status).toBe(404);
    });

    it("returns 404 for legacy PATCH /v1/accounts/auto-reload", async () => {
      const res = await request(app)
        .patch("/v1/accounts/auto-reload")
        .set(getAuthHeaders(orgId))
        .send({ reload_amount_cents: 1000 });
      expect(res.status).toBe(404);
    });

    it("returns 404 for legacy DELETE /v1/accounts/auto-reload", async () => {
      const res = await request(app)
        .delete("/v1/accounts/auto-reload")
        .set(getAuthHeaders(orgId));
      expect(res.status).toBe(404);
    });
  });
});
