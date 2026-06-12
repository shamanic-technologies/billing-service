import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import {
  setupStripeMocks,
  customerWithDefaultPM,
  customerWithoutPM,
} from "../helpers/mock-stripe.js";

describe("Accounts endpoints", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  const userId = "00000000-0000-0000-0000-000000000099";
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let fetchRunsOrgUsageTotalSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
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
    it("auto-creates a billing account with welcome promo redemption", async () => {
      ssMocks.hasAttachedCardPm.mockResolvedValue(false);

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.org_id).toBe(orgId);
      // SS paid = 0, local welcome = 200, usage = 0 → credited 200, balance 200.
      expect(res.body.credited_cents).toBe("200.0000000000");
      expect(res.body.usage_cents).toBe("0.0000000000");
      expect(res.body.balance_cents).toBe("200.0000000000");
      expect(res.body.has_payment_method).toBe(false);
      expect(res.body.has_auto_topup).toBe(false);
      expect(ssMocks.ensureCustomer).toHaveBeenCalled();
    });

    it("composes credited = paid topups + local credits, balance = credited − usage", async () => {
      await insertTestAccount({ orgId });
      ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("1000.0000000000");
      fetchRunsOrgUsageTotalSpy.mockResolvedValue({
        org_id: orgId,
        spent_cents: "75.0000000000",
        as_of: "2026-05-13T00:00:00.000Z",
      });

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      // No local credits (account inserted without welcome) → 1000 + 0 = 1000.
      expect(res.body.credited_cents).toBe("1000.0000000000");
      expect(res.body.usage_cents).toBe("75.0000000000");
      expect(res.body.balance_cents).toBe("925.0000000000");
    });

    it("returns negative balance_cents when usage > credited", async () => {
      await insertTestAccount({ orgId });
      ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("75.0000000000");
      fetchRunsOrgUsageTotalSpy.mockResolvedValue({
        org_id: orgId,
        spent_cents: "383.0000000000",
        as_of: "2026-05-13T00:00:00.000Z",
      });

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.balance_cents).toBe("-308.0000000000");
    });

    it("derives has_payment_method from attached card PMs (ignores default_payment_method)", async () => {
      await insertTestAccount({ orgId });
      // No default PM set, but a card is attached → has_payment_method must be true.
      ssMocks.getCustomerByOrg.mockResolvedValue(customerWithoutPM());
      ssMocks.hasAttachedCardPm.mockResolvedValue(true);

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.has_payment_method).toBe(true);
    });

    it("credited reflects only succeeded payment intents (failed PIs excluded)", async () => {
      await insertTestAccount({ orgId });
      // Helper already filters succeeded — assert by configuring its return.
      ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("55000.0000000000");
      fetchRunsOrgUsageTotalSpy.mockResolvedValue({
        org_id: orgId,
        spent_cents: "38289.2958000000",
        as_of: "2026-05-13T00:00:00.000Z",
      });

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      // 55000 paid + 0 local − 38289.2958 usage = 16710.7042 spendable
      expect(res.body.credited_cents).toBe("55000.0000000000");
      expect(res.body.balance_cents).toBe("16710.7042000000");
    });

    it("returns 502 when runs-service unavailable", async () => {
      await insertTestAccount({ orgId });
      fetchRunsOrgUsageTotalSpy.mockRejectedValue(new Error("runs-service down"));

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(502);
    });

    it("returns 502 when stripe-service unavailable", async () => {
      await insertTestAccount({ orgId });
      ssMocks.getCustomerByOrg.mockRejectedValue(new Error("stripe-service down"));

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(502);
    });

    it("returns 502 when payment_intents listing fails", async () => {
      await insertTestAccount({ orgId });
      ssMocks.sumSucceededTopupsForCustomer.mockRejectedValue(
        new Error("stripe-service /v1/payment_intents 500")
      );

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(502);
    });

    it("returns existing account without invoking ensureCustomer", async () => {
      await insertTestAccount({ orgId });

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(ssMocks.ensureCustomer).not.toHaveBeenCalled();
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
    });
  });

  describe("GET /v1/accounts/balance", () => {
    it("returns credited minus usage as balance", async () => {
      await insertTestAccount({ orgId });
      ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("150.0000000000");
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

    it("marks depleted when balance <= 0", async () => {
      await insertTestAccount({ orgId });
      // Default sum mock returns "0", default usage 0 → available = 0 → depleted.

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

  describe("PATCH /v1/accounts/auto_topup", () => {
    it("enables auto-topup when SS reports payment method present", async () => {
      await insertTestAccount({ orgId });
      ssMocks.getCustomerByOrg.mockResolvedValue(customerWithDefaultPM());

      const res = await request(app)
        .patch("/v1/accounts/auto_topup")
        .set(getAuthHeaders(orgId))
        .send({ topup_amount_cents: 5000, topup_threshold_cents: 1000 });

      expect(res.status).toBe(200);
      expect(res.body.topup_amount_cents).toBe(5000);
      expect(res.body.topup_threshold_cents).toBe(1000);
      expect(res.body.has_auto_topup).toBe(true);
    });

    it("rejects when SS reports no payment method", async () => {
      await insertTestAccount({ orgId });
      ssMocks.hasAttachedCardPm.mockResolvedValue(false);

      const res = await request(app)
        .patch("/v1/accounts/auto_topup")
        .set(getAuthHeaders(orgId))
        .send({ topup_amount_cents: 5000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Payment method required");
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
      await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 1000 });

      const res = await request(app)
        .delete("/v1/accounts/auto_topup")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.topup_amount_cents).toBeNull();
      expect(res.body.topup_threshold_cents).toBeNull();
      expect(res.body.has_auto_topup).toBe(false);
    });
  });

  describe("removed v1 routes", () => {
    it("returns 404 for /v1/customer_balance_transactions (moved to stripe-service)", async () => {
      const res = await request(app)
        .get("/v1/customer_balance_transactions")
        .set(getAuthHeaders(orgId));
      expect(res.status).toBe(404);
    });

    it("returns 404 for /v1/webhooks/stripe (moved to stripe-service)", async () => {
      const res = await request(app)
        .post("/v1/webhooks/stripe")
        .set({ "X-API-Key": "test-api-key" })
        .send({});
      expect(res.status).toBe(404);
    });
  });
});
