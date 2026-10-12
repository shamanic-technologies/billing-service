/**
 * A PREPAID card cannot start a subscription FREE TRIAL (owner 2026-10-12, prod
 * org 62594115-…: a Revolut prepaid Visa passed card verification, burned the $99
 * trial credit in 3.5h, then declined the $100 charge). Pins, for BOTH acquirers:
 *   1. start on a prepaid card -> 409 prepaid_card_trial_refused; no row, no
 *      trial credit, no charge;
 *   2. same org with a debit / credit card -> trial starts as before;
 *   3. a prepaid card still pays: a one-off top-up checkout, and a subscription
 *      with no trial (first month charged at start);
 *   + the checkout hands back a card form when the card on file is prepaid;
 *   + a stripe-service that does not state funding fails loud (no trial granted).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { localPromos, subscriptions } from "../../src/db/schema.js";
import { getLiveSubscription, getSubscriptionTrialGrantCents } from "../../src/lib/subscription.js";
import { toSubscriptionRecap, type SubscriptionRecap } from "../../src/lib/subscription-recap-client.js";

const orgId = "00000000-0000-0000-0000-0000000007b1";
const userId = "00000000-0000-0000-0000-0000000007b9";
const headers = getAuthHeaders(orgId, userId);

function card(acquirer: "revolut" | "stripe", funding: string | null | undefined) {
  const method: Record<string, unknown> = { id: acquirer === "stripe" ? "pm_1" : "rpm_1", type: "card", saved_for: "merchant" };
  if (funding !== undefined) {
    // stripe-service's shape: funding verbatim, prepaid true/false/null (null = not stated).
    method.funding = funding;
    method.prepaid = funding === null ? null : funding === "prepaid";
  }
  return { object: "saved_payment_method", org_id: orgId, acquirer, saved: true, method };
}

function recapWithRoi(roi: number | null): SubscriptionRecap {
  return toSubscriptionRecap({
    outbound: { emailsSent: 120, recipientsEnrolled: 60, sendStatus: "emails_sent" },
    expectedPositiveReplies: 3,
    expectedReturn: { roiMultiple: roi },
  });
}

describe("subscription free trial refuses prepaid cards", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let setUsage: (cents: string) => void;
  let sendSpy: ReturnType<typeof vi.fn>;
  let recapSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();

    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@new.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");
    // Default org: on the second acquirer (Revolut), card saved, recurring authorized.
    ssMocks.getSavedPaymentMethod.mockResolvedValue(card("revolut", "debit"));
    ssMocks.getCardSetup.mockResolvedValue({
      object: "card_setup",
      mode: "embedded_widget",
      script_url: "https://merchant.revolut.com/embed.js",
      environment: "prod",
      token: "tok_public",
      save_payment_method_for: "merchant",
    });

    const runsClient = await import("../../src/lib/runs-client.js");
    let usage = "0.0000000000";
    setUsage = (cents) => {
      usage = cents;
    };
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage,
      as_of: "2026-10-01T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage,
      as_of: "2026-10-01T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue("00000000-0000-0000-0000-00000000a001");
    vi.spyOn(runsClient, "completePlatformRun").mockResolvedValue(undefined);
    const costs = await import("../../src/lib/costs-client.js");
    vi.spyOn(costs, "resolveRequiredCents").mockResolvedValue("50.0000000000");
    const cs = await import("../../src/lib/campaign-service-client.js");
    vi.spyOn(cs, "fetchSpendableBudget").mockResolvedValue(null);
    vi.spyOn(cs, "fetchRecurringCampaignStatuses").mockResolvedValue({ ok: true, campaigns: [] });
    const burn = await import("../../src/lib/realized-burn.js");
    vi.spyOn(burn, "fetchRealizedDailyBurn").mockResolvedValue({
      dailyCents: "1000.0000000000",
      unavailableReason: null,
      windowDays: 14,
    });
    const ctx = await import("../../src/lib/budget-change-context.js");
    vi.spyOn(ctx, "fetchOrgIdentity").mockResolvedValue({ name: "Acme", externalId: "org_clerk1" });
    const recapClient = await import("../../src/lib/subscription-recap-client.js");
    recapSpy = vi.spyOn(recapClient, "fetchSubscriptionRecap").mockResolvedValue(recapWithRoi(1.2));
    const email = await import("../../src/lib/email-client.js");
    sendSpy = vi.fn();
    vi.spyOn(email, "sendEmail").mockImplementation(sendSpy);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  async function nothingStarted() {
    expect(await getLiveSubscription(orgId)).toBeNull();
    expect(await db.select().from(subscriptions).where(eq(subscriptions.orgId, orgId))).toHaveLength(0);
    expect(await getSubscriptionTrialGrantCents(orgId)).toBeNull();
    expect(await db.select().from(localPromos).where(eq(localPromos.orgId, orgId))).toHaveLength(0);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  }

  for (const acquirer of ["revolut", "stripe"] as const) {
    it(`${acquirer}: a prepaid card -> 409 prepaid_card_trial_refused, nothing granted or charged`, async () => {
      await insertTestAccount({ orgId });
      ssMocks.getSavedPaymentMethod.mockResolvedValue(card(acquirer, "prepaid"));
      const res = await request(app).post("/v1/accounts/subscription/start").set(headers).send({});
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        code: "prepaid_card_trial_refused",
        error: "Prepaid cards can't start a free trial. Use a debit or credit card, or add credit upfront.",
      });
      await nothingStarted();
    });

    for (const funding of ["debit", "credit"]) {
      it(`${acquirer}: a ${funding} card -> the trial starts as before`, async () => {
        await insertTestAccount({ orgId });
        ssMocks.getSavedPaymentMethod.mockResolvedValue(card(acquirer, funding));
        const res = await request(app).post("/v1/accounts/subscription/start").set(headers).send({});
        expect(res.status).toBe(200);
        expect(res.body.subscription).toMatchObject({ status: "trialing" });
        expect(res.body.trial_grant_cents).toBe(9900);
        expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
      });
    }

    it(`${acquirer}: prepaid refused, then the card replaced by a debit card -> the trial starts`, async () => {
      await insertTestAccount({ orgId });
      ssMocks.getSavedPaymentMethod.mockResolvedValue(card(acquirer, "prepaid"));
      let res = await request(app).post("/v1/accounts/subscription/start").set(headers).send({});
      expect(res.status).toBe(409);
      ssMocks.getSavedPaymentMethod.mockResolvedValue(card(acquirer, "debit"));
      res = await request(app).post("/v1/accounts/subscription/start").set(headers).send({});
      expect(res.status).toBe(200);
      expect(res.body.subscription).toMatchObject({ status: "trialing" });
    });

    it(`${acquirer}: checkout with a prepaid card on file -> card form + card_refused_reason prepaid_card`, async () => {
      await insertTestAccount({ orgId });
      ssMocks.getSavedPaymentMethod.mockResolvedValue(card(acquirer, "prepaid"));
      const res = await request(app)
        .post("/v1/accounts/subscription/checkout_session")
        .set(headers)
        .send({ monthly_amount_cents: 9900 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        trial_days: 3,
        card_required: true,
        card_refused_reason: "prepaid_card",
      });
      expect(res.body.card_setup).not.toBeNull();
      await nothingStarted();
    });

    it(`${acquirer}: acquirer silent on funding (prepaid null) -> trial allowed, logged loudly`, async () => {
      await insertTestAccount({ orgId });
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      ssMocks.getSavedPaymentMethod.mockResolvedValue(card(acquirer, null));
      const res = await request(app).post("/v1/accounts/subscription/start").set(headers).send({});
      expect(res.status).toBe(200);
      expect(err.mock.calls.some((c) => String(c[0]).includes("card funding not stated"))).toBe(true);
    });
  }

  it("a stripe-service that does not serve funding fails loud: 502, no trial granted", async () => {
    await insertTestAccount({ orgId });
    vi.spyOn(console, "error").mockImplementation(() => {});
    ssMocks.getSavedPaymentMethod.mockResolvedValue(card("revolut", undefined));
    const res = await request(app).post("/v1/accounts/subscription/start").set(headers).send({});
    expect(res.status).toBe(502);
    await nothingStarted();
  });

  it("checkout without a trial (one already used): a prepaid card is not refused", async () => {
    await insertTestAccount({ orgId });
    ssMocks.getSavedPaymentMethod.mockResolvedValue(card("revolut", "prepaid"));
    await db.insert(subscriptions).values({
      orgId,
      status: "canceled",
      monthlyAmountCents: 9900,
      trialStartedAt: new Date("2026-09-01T00:00:00Z"),
      trialEndsAt: new Date("2026-09-04T00:00:00Z"),
      currentPeriodStart: new Date("2026-09-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-09-04T00:00:00Z"),
    });
    const res = await request(app)
      .post("/v1/accounts/subscription/checkout_session")
      .set(headers)
      .send({ monthly_amount_cents: 9900 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ trial_days: null, card_required: false, card_refused_reason: null });
  });

  it("prepaid offer: a one-off top-up checkout with a prepaid card on file still works", async () => {
    await insertTestAccount({ orgId, paymentMode: "prepaid" });
    ssMocks.getSavedPaymentMethod.mockResolvedValue(card("revolut", "prepaid"));
    ssMocks.createCheckoutSession.mockResolvedValue({ url: "https://pay.example/x", session_id: "ord_1" });
    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(headers)
      .send({ success_url: "https://e.com/s", cancel_url: "https://e.com/c", topup_amount_cents: 10000 });
    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe("ord_1");
  });
});
