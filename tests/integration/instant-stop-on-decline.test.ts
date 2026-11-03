/**
 * INSTANT-STOP-ON-DECLINE-1103: from the FIRST refused charge, the org is refused
 * new spend and reads "cannot charge" at once, with no time wait.
 *
 * Prod 2026-11-03, Beyond Logic (postpaid, org 8c043fa7-…): a $50.02 reload from
 * usage_apply was refused at 14:57:04; the refusal lived only in the in-memory
 * reload backoff, so the payment outlook kept answering chargeable until the
 * hourly sweep wrote the streak at 15:27 — 34 minutes of sends on a refused card.
 *
 * These cases run the REAL charge path (lib/reload → chargeNow) with only the
 * acquirer call mocked, so they prove the refusal is recorded where it happens.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import * as reload from "../../src/lib/reload.js";
import * as ssClient from "../../src/lib/stripe-service-client.js";
import * as cardRefusedEmail from "../../src/lib/card-refused-email.js";
import * as ownerAlerts from "../../src/lib/owner-alerts.js";
import { _resetCoalescer } from "../../src/lib/reload-coalescer.js";
import { upsertCampaignAuthorizeCost } from "../../src/lib/campaign-costs.js";

const orgId = "00000000-0000-0000-0000-00000000d101";
const userId = "00000000-0000-0000-0000-000000000099";
const campaignId = "00000000-0000-0000-0000-00000000dc01";

const authorizeBody = {
  items: [{ costName: "anthropic-sonnet-4-5-tokens-input", quantity: 1000 }],
  description: "instant stop on decline",
};

function refusedCharge(): ssClient.ChargeResult {
  return {
    object: "charge_result",
    org_id: orgId,
    acquirer: "stripe",
    reference: "ch_refused_1",
    status: "failed",
    amount: 5002,
    currency: "usd",
    hosted_document_url: null,
    failure: {
      type: "card_error",
      code: "insufficient_funds",
      message: "Your card has insufficient funds.",
    },
  } as ssClient.ChargeResult;
}

describe("a refused charge stops the org at once", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let chargeSpy: ReturnType<typeof vi.spyOn>;
  let usage = { projected: "0.0000000000", actual: "0.0000000000" };

  beforeEach(async () => {
    vi.restoreAllMocks();
    _resetCoalescer();
    ssMocks = setupStripeMocks();
    // The REAL charge path: only the acquirer answer is mocked.
    vi.mocked(reload.reloadOffSession).mockRestore();
    chargeSpy = vi.spyOn(ssClient, "chargeOrgOffSession").mockResolvedValue(refusedCharge());
    vi.spyOn(cardRefusedEmail, "notifyCardRefused").mockImplementation(() => undefined as never);
    vi.spyOn(ownerAlerts, "notifyOwnerBillingEvent").mockImplementation(() => undefined as never);
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("billing@beyondlogic.test"));
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");
    await cleanTestData();

    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue("3.0000000000");
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage.projected,
      as_of: "x",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage.actual,
      as_of: "x",
    }));
    const campaignClient = await import("../../src/lib/campaign-service-client.js");
    vi.spyOn(campaignClient, "fetchSpendableBudget").mockResolvedValue(null);
    const burn = await import("../../src/lib/realized-burn.js");
    vi.spyOn(burn, "fetchRealizedDailyBurn").mockResolvedValue({
      dailyCents: "500.0000000000",
      unavailableReason: null,
      windowDays: 14,
    } as never);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  async function authorize() {
    return request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId, userId), "x-campaign-id": campaignId })
      .send(authorizeBody);
  }

  async function outlook() {
    return request(app)
      .get(`/internal/accounts/by-org/${orgId}/payment-outlook`)
      .set({ "x-api-key": process.env.BILLING_SERVICE_API_KEY ?? "test-api-key" });
  }

  async function affordability() {
    return request(app)
      .get(`/internal/campaigns/${campaignId}/affordability`)
      .set({ "x-api-key": process.env.BILLING_SERVICE_API_KEY ?? "test-api-key" });
  }

  it("POSTPAID (the prod replay): usage_apply's refused reload blocks the very next authorize, affordability and outlook", async () => {
    // $100 paid, $50 line, billed −$50.02 (credited 10000 − actual 15002), holds on top.
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 0 });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("10000.0000000000");
    usage = { projected: "20000.0000000000", actual: "15002.0000000000" };
    await upsertCampaignAuthorizeCost(campaignId, orgId, "3.0000000000");

    // Before the refusal the card is chargeable.
    expect((await outlook()).body.state).not.toBe("charge_blocked");

    const apply = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "15002" });
    expect(apply.status).toBe(202);
    expect(apply.body.topup_triggered).toBe(false);
    expect(chargeSpy).toHaveBeenCalledTimes(1);

    // A restart wiped the in-memory backoff: the verdict must still hold.
    _resetCoalescer();

    const auth = await authorize();
    expect(auth.status).toBe(200);
    expect(auth.body.sufficient).toBe(false);
    // Refused on the recorded refusal, not by presenting the card again.
    expect(chargeSpy).toHaveBeenCalledTimes(1);

    const aff = await affordability();
    expect(aff.body.affordable).toBe(false);

    const out = await outlook();
    expect(out.body.state).toBe("charge_blocked");
    expect(out.body.blockedReason).toBe("card_declined");

    // usage_apply does not re-present the refused card on the next run either.
    await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "15100" });
    expect(chargeSpy).toHaveBeenCalledTimes(1);
  });

  it("POSTPAID within its line: a refused charge still stops spend that would otherwise run on credit", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 0 });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("10000.0000000000");
    // billed −$20: inside the $50 line, authorize would say yes.
    usage = { projected: "12000.0000000000", actual: "12000.0000000000" };
    expect((await authorize()).body.sufficient).toBe(true);

    // A charge is refused (any path: pay balance, card change, month end).
    const outcome = await reload.reloadOffSession(orgId, 2000, "ik-pay-balance");
    expect(outcome.status).toBe("failed");

    expect((await authorize()).body.sufficient).toBe(false);
    expect((await outlook()).body.state).toBe("charge_blocked");
  });

  it("PREPAID: the refused auto top-up blocks the next authorize and the outlook, without re-presenting the card", async () => {
    await insertTestAccount({
      orgId,
      paymentMode: "prepaid",
      topupAmountCents: 1500,
      topupThresholdCents: 500,
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("1000.0000000000");
    usage = { projected: "1000.0000000000", actual: "1000.0000000000" };
    await upsertCampaignAuthorizeCost(campaignId, orgId, "3.0000000000");

    const first = await authorize();
    expect(first.body.sufficient).toBe(false);
    expect(chargeSpy).toHaveBeenCalledTimes(1);

    _resetCoalescer();
    const next = await authorize();
    expect(next.body.sufficient).toBe(false);
    expect(chargeSpy).toHaveBeenCalledTimes(1);

    expect((await affordability()).body.affordable).toBe(false);
    const out = await outlook();
    expect(out.body.state).toBe("charge_blocked");
    expect(out.body.blockedReason).toBe("card_declined");
  });

  it("money arriving ends the block: a top-up moves credited and spend resumes", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 0 });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("10000.0000000000");
    usage = { projected: "12000.0000000000", actual: "12000.0000000000" };
    await reload.reloadOffSession(orgId, 2000, "ik-pay-balance");
    expect((await authorize()).body.sufficient).toBe(false);

    // The customer pays $50 by hand: credited rises.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("15000.0000000000");
    expect((await authorize()).body.sufficient).toBe(true);
    expect((await outlook()).body.state).not.toBe("charge_blocked");
  });

  it("a SUBSCRIPTION org's refused charge does not stop its spend here (its renewal has its own lifecycle)", async () => {
    await insertTestAccount({ orgId, paymentMode: "subscription" });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("10000.0000000000");
    usage = { projected: "1000.0000000000", actual: "1000.0000000000" };
    await reload.reloadOffSession(orgId, 9900, "ik-renewal");
    expect((await authorize()).body.sufficient).toBe(true);
  });
});
