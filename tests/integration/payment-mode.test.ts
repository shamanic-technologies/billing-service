/**
 * PREPAID or POSTPAID — the customer's explicit choice (lib/payment-mode).
 *
 * The acceptance criteria this pins:
 *   - every existing org reads postpaid, and its payment outlook is unchanged
 *     (no card → charge_blocked / no_chargeable_card, exactly as before);
 *   - a prepaid org with no card and a positive balance is NOT charge_blocked,
 *     and its campaign pre-flight is not refused for a payment reason;
 *   - the same prepaid org at zero is refused by the ordinary affordability
 *     check (out of credit), not by a card rule;
 *   - a postpaid org that owes money cannot become prepaid without settling.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertTestAccount,
  insertTestCampaignCost,
} from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { billingAccounts } from "../../src/db/schema.js";
import { _resetCoalescer } from "../../src/lib/reload-coalescer.js";
import { flagUncollectableDebt } from "../../src/lib/unpaid-debt.js";

const orgId = "00000000-0000-0000-0000-0000000005a1";
const campaignId = "00000000-0000-0000-0000-0000000005c1";
const apiKeyHeaders = { "X-API-Key": "test-api-key" };

const outlook = (id: string) => `/internal/accounts/by-org/${id}/payment-outlook`;
const modePath = (id: string) => `/internal/accounts/by-org/${id}/payment-mode`;
const affordability = (id: string) => `/internal/campaigns/${id}/affordability`;

describe("payment mode: prepaid / postpaid", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let setUsage: (cents: string) => void;

  beforeEach(async () => {
    vi.restoreAllMocks();
    _resetCoalescer();
    await cleanTestData();

    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("agency@client.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue(null);

    const runsClient = await import("../../src/lib/runs-client.js");
    let usage = "0.0000000000";
    setUsage = (cents: string) => {
      usage = cents;
    };
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage,
      as_of: "2026-09-27T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage,
      as_of: "2026-09-27T00:00:00.000Z",
    }));

    const campaignClient = await import("../../src/lib/campaign-service-client.js");
    vi.spyOn(campaignClient, "fetchSpendableBudget").mockResolvedValue(null);
    const burn = await import("../../src/lib/realized-burn.js");
    vi.spyOn(burn, "fetchRealizedDailyBurn").mockResolvedValue({
      dailyCents: "1000.0000000000",
      unavailableReason: null,
      windowDays: 14,
    });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  /** Staff grant funding: credited comes from local promos, not Stripe. */
  async function fundWithGrant(cents: string) {
    const promos = await import("../../src/lib/promos.js");
    vi.spyOn(promos, "sumLocalPromoCreditsForOrg").mockResolvedValue(cents);
  }

  it("every existing org reads postpaid, and no card is still charge_blocked", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 200 });
    await fundWithGrant("10000.0000000000");

    const mode = await request(app).get(modePath(orgId)).set(apiKeyHeaders);
    expect(mode.status).toBe(200);
    expect(mode.body).toEqual({ org_id: orgId, payment_mode: "postpaid" });

    const res = await request(app).get(outlook(orgId)).set(apiKeyHeaders);
    expect(res.status).toBe(200);
    expect(res.body.paymentMode).toBe("postpaid");
    expect(res.body.state).toBe("charge_blocked");
    expect(res.body.blockedReason).toBe("no_chargeable_card");
  });

  it("prepaid, no card, positive balance: NOT charge_blocked, and the campaign may run", async () => {
    await insertTestAccount({ orgId, paymentMode: "prepaid" });
    await fundWithGrant("10000.0000000000"); // $100 staff grant
    setUsage("2500.0000000000");
    await insertTestCampaignCost({ campaignId, orgId, lastAuthorizeRequiredCents: "50.0000000000" });

    const res = await request(app).get(outlook(orgId)).set(apiKeyHeaders);
    expect(res.status).toBe(200);
    expect(res.body.paymentMode).toBe("prepaid");
    expect(res.body.state).not.toBe("charge_blocked");
    expect(res.body.state).toBe("no_autopay");
    expect(res.body.blockedReason).toBeNull();
    expect(res.body.floorCents).toBe("0");

    const aff = await request(app).get(affordability(campaignId)).set(apiKeyHeaders);
    expect(aff.body.affordable).toBe(true);
  });

  it("prepaid at zero balance: refused by the affordability check, not by a card rule", async () => {
    await insertTestAccount({ orgId, paymentMode: "prepaid" });
    await fundWithGrant("10000.0000000000");
    setUsage("10000.0000000000"); // balance exactly 0
    await insertTestCampaignCost({ campaignId, orgId, lastAuthorizeRequiredCents: "50.0000000000" });

    const aff = await request(app).get(affordability(campaignId)).set(apiKeyHeaders);
    expect(aff.body.affordable).toBe(false);
    expect(aff.body.balanceCents).toBe("0.0000000000");

    const res = await request(app).get(outlook(orgId)).set(apiKeyHeaders);
    expect(res.body.state).not.toBe("charge_blocked");
  });

  it("prepaid with auto top-up and a card: the floor is ZERO, never a credit line", async () => {
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("150000.0000000000"); // top rung for postpaid
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 0, paymentMode: "prepaid" });
    setUsage("150100.0000000000"); // balance −100 cents: inside any postpaid line
    await insertTestCampaignCost({ campaignId, orgId, lastAuthorizeRequiredCents: "10.0000000000" });

    const aff = await request(app).get(affordability(campaignId)).set(apiKeyHeaders);
    expect(aff.body.affordable).toBe(false);

    const res = await request(app).get(outlook(orgId)).set(apiKeyHeaders);
    expect(res.body.floorCents).toBe("0");
    expect(res.body.state).toBe("charge_due_now");

    const acct = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(acct.body.payment_mode).toBe("prepaid");
    expect(acct.body.topup_threshold_cents).toBe(0);
    expect(acct.body.topup_amount_cents).toBe(50000);
  });

  it("postpaid → prepaid with a debt and no card: refused, mode unchanged, nothing charged", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 200 });
    setUsage("1234.0000000000"); // owes $12.34

    const res = await request(app)
      .put(modePath(orgId))
      .set(apiKeyHeaders)
      .send({ payment_mode: "prepaid" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("outstanding_balance_no_card");
    expect(res.body.owed_cents).toBe("1234.0000000000");
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
    const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(row.paymentMode).toBe("postpaid");
  });

  it("postpaid → prepaid with a debt and a card: charges EXACTLY what is owed, then switches", async () => {
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 200 });
    setUsage("1234.5000000000"); // owes $12.345 → 1235 cents

    const res = await request(app)
      .put(modePath(orgId))
      .set(apiKeyHeaders)
      .send({ payment_mode: "prepaid" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      org_id: orgId,
      payment_mode: "prepaid",
      settled_cents: "1235",
      auto_topup_enabled: true,
    });
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(1235);
  });

  it("postpaid → prepaid when the card declines: refused with the reason", async () => {
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");
    ssMocks.reloadOffSession.mockRejectedValue(
      new Error("stripe-service POST /internal/charges/by-org/x failed: 402 card_declined")
    );
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 200 });
    setUsage("5000.0000000000");

    const res = await request(app)
      .put(modePath(orgId))
      .set(apiKeyHeaders)
      .send({ payment_mode: "prepaid" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("outstanding_balance_charge_declined");
    const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(row.paymentMode).toBe("postpaid");
  });

  it("postpaid → prepaid owing less than a chargeable amount: refused, never charged", async () => {
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 200 });
    setUsage("20.0000000000");

    const res = await request(app)
      .put(modePath(orgId))
      .set(apiKeyHeaders)
      .send({ payment_mode: "prepaid" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("outstanding_balance_below_minimum_charge");
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("becoming prepaid with NO card leaves auto top-up off; back to postpaid charges nothing", async () => {
    await insertTestAccount({ orgId, topupAmountCents: undefined });
    await db
      .update(billingAccounts)
      .set({ topupAmountCents: null, topupThresholdCents: null })
      .where(eq(billingAccounts.orgId, orgId));
    await fundWithGrant("5000.0000000000");

    const toPrepaid = await request(app)
      .put(modePath(orgId))
      .set(apiKeyHeaders)
      .send({ payment_mode: "prepaid" });
    expect(toPrepaid.status).toBe(200);
    // No chargeable card (the suite default), so the flag stays off: a flag set
    // with nothing to charge is a configuration that lies. With a card it is
    // armed — see money-path-audit.test.ts.
    expect(toPrepaid.body.auto_topup_enabled).toBe(false);
    expect(toPrepaid.body.settled_cents).toBe("0");

    const again = await request(app)
      .put(modePath(orgId))
      .set(apiKeyHeaders)
      .send({ payment_mode: "prepaid" });
    expect(again.status).toBe(200);

    const toPostpaid = await request(app)
      .put(modePath(orgId))
      .set(apiKeyHeaders)
      .send({ payment_mode: "postpaid" });
    expect(toPostpaid.status).toBe(200);
    expect(toPostpaid.body.payment_mode).toBe("postpaid");
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();

    // Postpaid rules apply again: no card → charge_blocked.
    const res = await request(app).get(outlook(orgId)).set(apiKeyHeaders);
    expect(res.body.state).toBe("charge_blocked");
    expect(res.body.blockedReason).toBe("no_chargeable_card");
  });

  it("the customer reads and sets it through /v1 (account created on first touch)", async () => {
    const newOrg = "00000000-0000-0000-0000-0000000005a2";
    const put = await request(app)
      .put("/v1/accounts/payment_mode")
      .set(getAuthHeaders(newOrg))
      .send({ payment_mode: "prepaid" });
    expect(put.status).toBe(200);
    expect(put.body.payment_mode).toBe("prepaid");

    const get = await request(app).get("/v1/accounts/payment_mode").set(getAuthHeaders(newOrg));
    expect(get.status).toBe(200);
    expect(get.body).toEqual({ org_id: newOrg, payment_mode: "prepaid" });

    const bad = await request(app)
      .put("/v1/accounts/payment_mode")
      .set(getAuthHeaders(newOrg))
      .send({ payment_mode: "agency" });
    expect(bad.status).toBe(400);
  });

  it("internal read 404s for an org with no billing account", async () => {
    const res = await request(app)
      .get(modePath("00000000-0000-0000-0000-0000000005ff"))
      .set(apiKeyHeaders);
    expect(res.status).toBe(404);
  });

  it("a prepaid org's overshoot is not flagged as an uncollectable debt", async () => {
    await insertTestAccount({ orgId, paymentMode: "prepaid" });
    setUsage("300.0000000000");
    const outcome = await flagUncollectableDebt({ orgId });
    expect(outcome.state).toBe("prepaid");
  });
});
