import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import {
  setupStripeMocks,
  customerWithDefaultPM,
  customerWithoutPM,
} from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { localPromoCodes, localPromos, FIRST_LOAD_MATCH_CODE } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

describe("Accounts endpoints", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  const userId = "00000000-0000-0000-0000-000000000099";
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let fetchRunsOrgUsageTotalSpy: ReturnType<typeof vi.fn>;
  let fetchRunsOrgActualUsageTotalSpy: ReturnType<typeof vi.fn>;

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
    fetchRunsOrgActualUsageTotalSpy = vi.fn().mockResolvedValue({
      spent_cents: "0.0000000000",
    });
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(
      fetchRunsOrgActualUsageTotalSpy
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
      expect(res.body.actual_balance_cents).toBe("200.0000000000");
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
      expect(res.body.actual_balance_cents).toBe("1000.0000000000");
    });

    it("keeps spendable balance reduced by holds but actual balance actual-only", async () => {
      await insertTestAccount({ orgId });
      ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("3000.0000000000");
      fetchRunsOrgUsageTotalSpy.mockResolvedValue({
        org_id: orgId,
        spent_cents: "105.0000000000",
        as_of: "2026-05-13T00:00:00.000Z",
      });
      fetchRunsOrgActualUsageTotalSpy.mockResolvedValue({
        spent_cents: "95.0000000000",
      });

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.credited_cents).toBe("3000.0000000000");
      expect(res.body.usage_cents).toBe("105.0000000000");
      expect(res.body.balance_cents).toBe("2895.0000000000");
      expect(res.body.actual_balance_cents).toBe("2905.0000000000");
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
      expect(res.body.actual_balance_cents).toBe("75.0000000000");
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

    it("reports auto_reload_supported=true for a non-blocked card country", async () => {
      await insertTestAccount({ orgId });
      ssMocks.getOrgCardCountry.mockResolvedValue("US");

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.auto_reload_supported).toBe(true);
      expect(res.body.auto_reload_unsupported_reason).toBeNull();
      expect(res.body.card_country).toBe("US");
    });

    it("reports auto_reload_supported=false + reason for an India-issued card", async () => {
      // Account has full topup config, but the India card can't be charged off_session
      // → auto_reload_supported false, reason set, has_auto_topup forced false.
      await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 1000 });
      ssMocks.getOrgCardCountry.mockResolvedValue("IN");

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.auto_reload_supported).toBe(false);
      expect(res.body.auto_reload_unsupported_reason).toBe("card_issuing_country_unsupported");
      expect(res.body.card_country).toBe("IN");
      expect(res.body.has_payment_method).toBe(true);
      expect(res.body.has_auto_topup).toBe(false);
    });

    it("enabled account surfaces the DERIVED tier scaled to cumulative paid ($1000 → $500 line)", async () => {
      await insertTestAccount({ orgId, topupAmountCents: 1000, topupThresholdCents: 200 });
      // Cumulative paid $1000 → high tier {amount 50000, threshold -50000}.
      ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("100000.0000000000");

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.topup_amount_cents).toBe(50000);
      expect(res.body.topup_threshold_cents).toBe(-50000);
    });

    it("disabled account (no topup config) → topup amount/threshold null", async () => {
      await insertTestAccount({ orgId }); // topupAmountCents null
      ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("100000.0000000000");

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(200);
      expect(res.body.topup_amount_cents).toBeNull();
      expect(res.body.topup_threshold_cents).toBeNull();
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
      expect(res.body.actual_balance_cents).toBe("55000.0000000000");
    });

    it("returns 502 when runs-service unavailable", async () => {
      await insertTestAccount({ orgId });
      fetchRunsOrgUsageTotalSpy.mockRejectedValue(new Error("runs-service down"));

      const res = await request(app)
        .get("/v1/accounts")
        .set(getAuthHeaders(orgId));

      expect(res.status).toBe(502);
    });

    it("returns 502 when actual-only runs usage is unavailable", async () => {
      await insertTestAccount({ orgId });
      fetchRunsOrgActualUsageTotalSpy.mockRejectedValue(new Error("runs-service actual down"));

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
        actual_balance_cents: "150.0000000000",
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
    it("enables auto-topup; response returns the DERIVED tier, not the posted daily amount", async () => {
      await insertTestAccount({ orgId });
      ssMocks.getCustomerByOrg.mockResolvedValue(customerWithDefaultPM());
      // Posted daily amount/threshold are now only the enabled flag. Cumulative
      // paid = 0 → start tier {amount 5000, threshold -5000} (negative floor).
      ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");

      const res = await request(app)
        .patch("/v1/accounts/auto_topup")
        .set(getAuthHeaders(orgId))
        .send({ topup_amount_cents: 1234, topup_threshold_cents: 999 });

      expect(res.status).toBe(200);
      expect(res.body.topup_amount_cents).toBe(5000);
      expect(res.body.topup_threshold_cents).toBe(-5000);
      expect(res.body.has_auto_topup).toBe(true);
    });

    it("rejects when SS reports no payment method", async () => {
      await insertTestAccount({ orgId });
      ssMocks.hasAttachedCardPm.mockResolvedValue(false);

      const res = await request(app)
        .patch("/v1/accounts/auto_topup")
        .set(getAuthHeaders(orgId))
        .send({ topup_amount_cents: 5000, topup_threshold_cents: 1000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Payment method required");
    });

    it("rejects enabling auto-topup for an India-issued card (off_session mandate unsupported)", async () => {
      await insertTestAccount({ orgId });
      ssMocks.hasAttachedCardPm.mockResolvedValue(true);
      ssMocks.getOrgCardCountry.mockResolvedValue("IN");

      const res = await request(app)
        .patch("/v1/accounts/auto_topup")
        .set(getAuthHeaders(orgId))
        .send({ topup_amount_cents: 5000, topup_threshold_cents: 1000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("IN");
      expect(res.body.error).toContain("Auto-reload is unavailable");
    });

    it("requires an explicit auto-topup threshold", async () => {
      await insertTestAccount({ orgId });

      const res = await request(app)
        .patch("/v1/accounts/auto_topup")
        .set(getAuthHeaders(orgId))
        .send({ topup_amount_cents: 5000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("topup_threshold_cents");
      expect(ssMocks.getCustomerByOrg).not.toHaveBeenCalled();
    });

    it("returns 404 for unknown org", async () => {
      const res = await request(app)
        .patch("/v1/accounts/auto_topup")
        .set(getAuthHeaders("00000000-0000-0000-0000-999999999999"))
        .send({ topup_amount_cents: 2000, topup_threshold_cents: 100 });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /v1/accounts/wallet_setup", () => {
    it.each([
      { orgId: "00000000-0000-0000-0000-000000000101", load: 1000, expectedBonus: "1000.0000000000", expectedBalance: "2000.0000000000" },
      { orgId: "00000000-0000-0000-0000-000000000102", load: 2500, expectedBonus: "2500.0000000000", expectedBalance: "5000.0000000000" },
      { orgId: "00000000-0000-0000-0000-000000000103", load: 5000, expectedBonus: "2500.0000000000", expectedBalance: "7500.0000000000" },
    ])(
      "charges initial load $load and applies capped first-load match",
      async ({ orgId, load, expectedBonus, expectedBalance }) => {
        ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue(`${load}.0000000000`);

        const res = await request(app)
          .post("/v1/accounts/wallet_setup")
          .set(getAuthHeaders(orgId, userId))
          .send({
            initial_load_amount_cents: load,
            topup_amount_cents: 3000,
            topup_threshold_cents: 700,
          });

        expect(res.status).toBe(200);
        // Posted daily amount/threshold (3000/700) are only the enabled flag;
        // the response returns the derived tier. These loads (≤ $50) all resolve
        // to the start tier → amount 5000, threshold -5000.
        expect(res.body.topup_amount_cents).toBe(5000);
        expect(res.body.topup_threshold_cents).toBe(-5000);
        expect(res.body.has_auto_topup).toBe(true);
        expect(res.body.first_load_match_applied).toBe(true);
        expect(res.body.first_load_match_cents).toBe(expectedBonus);
        expect(res.body.balance_cents).toBe(expectedBalance);
        expect(ssMocks.reloadViaPaymentIntent).toHaveBeenCalledWith(
          expect.objectContaining({ "x-org-id": orgId }),
          load,
          expect.any(String),
          { org_id: orgId, billing_reason: "initial_load" }
        );
      }
    );

    it("does not apply the first-load match more than once per org", async () => {
      const paidByCall = ["1000.0000000000", "2000.0000000000"];
      ssMocks.sumSucceededTopupsForCustomer.mockImplementation(async () => {
        return paidByCall.shift() ?? "2000.0000000000";
      });

      const body = {
        initial_load_amount_cents: 1000,
        topup_amount_cents: 3000,
        topup_threshold_cents: 700,
      };

      const first = await request(app)
        .post("/v1/accounts/wallet_setup")
        .set(getAuthHeaders(orgId, userId))
        .send(body);
      const second = await request(app)
        .post("/v1/accounts/wallet_setup")
        .set(getAuthHeaders(orgId, userId))
        .send(body);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body.first_load_match_applied).toBe(true);
      expect(first.body.first_load_match_cents).toBe("1000.0000000000");
      expect(second.body.first_load_match_applied).toBe(false);
      expect(second.body.first_load_match_cents).toBe("0.0000000000");
      expect(second.body.balance_cents).toBe("3000.0000000000");

      const [matchCode] = await db
        .select()
        .from(localPromoCodes)
        .where(eq(localPromoCodes.code, FIRST_LOAD_MATCH_CODE))
        .limit(1);
      const grants = await db
        .select()
        .from(localPromos)
        .where(eq(localPromos.promoCodeId, matchCode.id));
      expect(grants).toHaveLength(1);
      expect(grants[0].amountCents).toBe("1000.0000000000");
    });

    it("requires all wallet setup amounts explicitly", async () => {
      const res = await request(app)
        .post("/v1/accounts/wallet_setup")
        .set(getAuthHeaders(orgId, userId))
        .send({ initial_load_amount_cents: 1000, topup_amount_cents: 3000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("topup_threshold_cents");
      expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
    });

    it("rejects wallet setup when no payment method is attached", async () => {
      ssMocks.hasAttachedCardPm.mockResolvedValue(false);

      const res = await request(app)
        .post("/v1/accounts/wallet_setup")
        .set(getAuthHeaders(orgId, userId))
        .send({
          initial_load_amount_cents: 1000,
          topup_amount_cents: 3000,
          topup_threshold_cents: 700,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Payment method required");
      expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
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
