/**
 * SUBSCRIPTION — the third payment mode (lib/subscription). Pins the owner's model:
 *   - a test org can start a trial subscription; once observed it is in subscription
 *     mode and holds $99 of free credit (topped up TO $99, never on top of a gift);
 *   - the trial grant is once per org (a replayed read never grants twice);
 *   - a paid invoice is credited exactly by the amount paid (it is an ordinary
 *     succeeded payment; billing adds nothing of its own);
 *   - +$100 raise: refused while trialing, off-ladder or not higher;
 *   - cancel / resume;
 *   - staff (only) can set mode=subscription; the customer switch cannot;
 *   - a subscription org never reloads: floor 0, no auto top-up, no_autopay.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertTestAccount,
  insertTestPromoGrant,
} from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { billingAccounts } from "../../src/db/schema.js";
import { resolvePostpaidTier } from "../../src/lib/topup-tier.js";
import { settleSignupWelcome } from "../../src/lib/trial-seed.js";
import {
  ABANDONED_CHECKOUT_MS,
  runSubscriptionSettleSweep,
} from "../../src/lib/subscription.js";
import type { OrgSubscription } from "../../src/lib/subscription-client.js";

const orgId = "00000000-0000-0000-0000-0000000005b1";
const userId = "00000000-0000-0000-0000-0000000005b9";
const apiKeyHeaders = { "X-API-Key": "test-api-key" };
const headers = getAuthHeaders(orgId, userId);

function sub(over: Partial<OrgSubscription> = {}): OrgSubscription {
  return {
    id: "sub_test_1",
    status: "trialing",
    trialEnd: "2026-10-04T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: "2026-10-04T12:00:00.000Z",
    monthlyAmountCents: 9900,
    currency: "usd",
    hasPaymentMethod: true,
    createdAt: "2026-10-01T12:00:00.000Z",
    ...over,
  };
}

describe("subscription payment mode", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let subs: OrgSubscription[];
  let client: typeof import("../../src/lib/subscription-client.js");
  let setUsage: (cents: string) => void;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    subs = [];

    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@new.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");

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
    const campaignClient = await import("../../src/lib/campaign-service-client.js");
    vi.spyOn(campaignClient, "fetchSpendableBudget").mockResolvedValue(null);
    const burn = await import("../../src/lib/realized-burn.js");
    vi.spyOn(burn, "fetchRealizedDailyBurn").mockResolvedValue({
      dailyCents: "1000.0000000000",
      unavailableReason: null,
      windowDays: 14,
    });

    client = await import("../../src/lib/subscription-client.js");
    vi.spyOn(client, "fetchOrgSubscriptions").mockImplementation(async () => subs);
    vi.spyOn(client, "createSubscriptionCheckout").mockResolvedValue({
      sessionId: "cs_test_1",
      url: null,
      clientSecret: "cs_test_1_secret",
    });
    vi.spyOn(client, "updateSubscriptionMonthlyAmount").mockImplementation(
      async (_o, _id, cents) => ({ ...subs[0], monthlyAmountCents: cents })
    );
    vi.spyOn(client, "setSubscriptionCancelAtPeriodEnd").mockImplementation(
      async (_o, _id, flag) => ({ ...subs[0], cancelAtPeriodEnd: flag })
    );
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  async function account() {
    const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    return row;
  }

  it("a new org starts a trial checkout: embedded by default, $99/month, 3-day trial, stamped", async () => {
    await insertTestAccount({ orgId });
    const res = await request(app)
      .post("/v1/accounts/subscription/checkout_session")
      .set(headers)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      mode: "embedded",
      session_id: "cs_test_1",
      client_secret: "cs_test_1_secret",
      url: null,
      trial_days: 3,
      monthly_amount_cents: 9900,
      currency: "usd",
    });
    const [calledOrg, call] = vi.mocked(client.createSubscriptionCheckout).mock.calls[0];
    expect(calledOrg).toBe(orgId);
    expect(call).toMatchObject({ monthlyAmountCents: 9900, trialDays: 3, uiMode: "embedded", userId });
    // A Stripe customer exists before the checkout (stripe-service refuses one without).
    expect(ssMocks.getCustomerByOrgOrNull).toHaveBeenCalled();
    expect((await account()).subscriptionCheckoutStartedAt).not.toBeNull();
  });

  it("hosted checkout needs success_url + cancel_url", async () => {
    await insertTestAccount({ orgId });
    const res = await request(app)
      .post("/v1/accounts/subscription/checkout_session")
      .set(headers)
      .send({ ui_mode: "hosted" });
    expect(res.status).toBe(400);
  });

  it("refuses an existing PAYING org (staff moves it), a non-Stripe org, and a second subscription", async () => {
    await insertTestAccount({ orgId });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("5000.0000000000");
    let res = await request(app).post("/v1/accounts/subscription/checkout_session").set(headers).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("existing_paying_org");

    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.getOrgAcquirer.mockResolvedValue("revolut");
    res = await request(app).post("/v1/accounts/subscription/checkout_session").set(headers).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("acquirer_not_supported");

    ssMocks.getOrgAcquirer.mockResolvedValue("stripe");
    subs = [sub()];
    res = await request(app).post("/v1/accounts/subscription/checkout_session").set(headers).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("subscription_exists");
    expect(client.createSubscriptionCheckout).not.toHaveBeenCalled();
  });

  it("after checkout: the read enters subscription mode and holds exactly $99, once", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 0 });
    await request(app).post("/v1/accounts/subscription/checkout_session").set(headers).send({});
    subs = [sub()];

    const res = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(res.status).toBe(200);
    expect(res.body.payment_mode).toBe("subscription");
    expect(res.body.trial_grant_cents).toBe(9900);
    expect(res.body.credits_remaining_cents).toBe("9900.0000000000");
    expect(res.body.subscription).toMatchObject({
      id: "sub_test_1",
      status: "trialing",
      trial_end: "2026-10-04T12:00:00.000Z",
      next_charge_at: "2026-10-04T12:00:00.000Z",
      monthly_amount_cents: 9900,
      has_payment_method: true,
      can_raise: false,
    });
    const row = await account();
    expect(row.paymentMode).toBe("subscription");
    expect(row.topupAmountCents).toBeNull();
    expect(row.subscriptionCheckoutStartedAt).toBeNull();

    // Replay: no second grant.
    const again = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(again.body.credits_remaining_cents).toBe("9900.0000000000");
  });

  it("the trial grant tops free credit UP TO $99 (a $30 welcome already held → +$69)", async () => {
    await insertTestAccount({ orgId });
    await insertTestPromoGrant({ orgId, userId, amountCents: 3000, promoCode: "welcome" });
    await request(app).post("/v1/accounts/subscription/checkout_session").set(headers).send({});
    subs = [sub()];

    const res = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(res.body.trial_grant_cents).toBe(6900);
    expect(res.body.credits_remaining_cents).toBe("9900.0000000000");

    // A welcome arriving at signup AFTER the trial adds nothing on top.
    const signup = await settleSignupWelcome(orgId, null);
    expect(signup.welcomeGrantedCents).toBe(0);
  });

  it("a paid invoice is credited by exactly what was paid", async () => {
    await insertTestAccount({ orgId });
    await request(app).post("/v1/accounts/subscription/checkout_session").set(headers).send({});
    subs = [sub()];
    await request(app).get("/v1/accounts/subscription").set(headers);

    // Trial over, first invoice paid: stripe-service now reports a $99 payment.
    subs = [sub({ status: "active", currentPeriodEnd: "2026-11-04T12:00:00.000Z" })];
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("9900.0000000000");
    setUsage("1000.0000000000");
    const res = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(res.body.credits_remaining_cents).toBe("18800.0000000000"); // 9900 trial + 9900 paid − 1000 used
    expect(res.body.trial_grant_cents).toBe(9900);
    expect(res.body.subscription.next_charge_at).toBe("2026-11-04T12:00:00.000Z");
    expect(res.body.subscription.can_raise).toBe(true);
    expect(res.body.subscription.next_raise_monthly_amount_cents).toBe(19900);
  });

  it("+$100: refused while trialing, off-ladder, or not higher; applied when active", async () => {
    await insertTestAccount({ orgId, paymentMode: "subscription" });
    subs = [sub()];
    let res = await request(app).patch("/v1/accounts/subscription").set(headers).send({ monthly_amount_cents: 19900 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("subscription_trialing");

    subs = [sub({ status: "active" })];
    res = await request(app).patch("/v1/accounts/subscription").set(headers).send({ monthly_amount_cents: 15000 });
    expect(res.status).toBe(400);
    res = await request(app).patch("/v1/accounts/subscription").set(headers).send({ monthly_amount_cents: 9900 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("amount_not_higher");

    res = await request(app).patch("/v1/accounts/subscription").set(headers).send({ monthly_amount_cents: 19900 });
    expect(res.status).toBe(200);
    expect(res.body.subscription.monthly_amount_cents).toBe(19900);
    expect(client.updateSubscriptionMonthlyAmount).toHaveBeenCalledWith(orgId, "sub_test_1", 19900);
  });

  it("cancel at period end, then resume; none → 404", async () => {
    await insertTestAccount({ orgId, paymentMode: "subscription" });
    let res = await request(app).post("/v1/accounts/subscription/cancel").set(headers);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("no_subscription");

    subs = [sub({ status: "active" })];
    res = await request(app).post("/v1/accounts/subscription/cancel").set(headers);
    expect(res.status).toBe(200);
    expect(res.body.subscription.cancel_at_period_end).toBe(true);
    expect(res.body.subscription.next_charge_at).toBeNull();

    res = await request(app).post("/v1/accounts/subscription/resume").set(headers);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("subscription_not_cancel_pending");

    subs = [sub({ status: "active", cancelAtPeriodEnd: true })];
    res = await request(app).post("/v1/accounts/subscription/resume").set(headers);
    expect(res.status).toBe(200);
    expect(res.body.subscription.cancel_at_period_end).toBe(false);
  });

  it("staff can set mode=subscription (auto top-up disarmed); the customer switch cannot", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 200 });

    let res = await request(app).put("/v1/accounts/payment_mode").set(headers).send({ payment_mode: "subscription" });
    expect(res.status).toBe(400);

    res = await request(app)
      .put(`/internal/accounts/by-org/${orgId}/payment-mode`)
      .set(apiKeyHeaders)
      .send({ payment_mode: "subscription" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      org_id: orgId,
      payment_mode: "subscription",
      settled_cents: "0",
      auto_topup_enabled: false,
    });

    res = await request(app).put("/v1/accounts/payment_mode").set(headers).send({ payment_mode: "prepaid" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("subscription_mode_staff_only");
    expect((await account()).paymentMode).toBe("subscription");
  });

  it("a subscription org never reloads: no tier, auto top-up refused, outlook no_autopay", async () => {
    expect(
      resolvePostpaidTier({
        topupEnabled: true,
        hasCardPm: true,
        autoReloadSupported: true,
        paidTopupsCents: "200000",
        paymentMode: "subscription",
      })
    ).toEqual({ tier: null, thresholdCents: "0" });

    await insertTestAccount({ orgId, paymentMode: "subscription" });
    const patch = await request(app)
      .patch("/v1/accounts/auto_topup")
      .set(headers)
      .send({ topup_amount_cents: 5000, topup_threshold_cents: 0 });
    expect(patch.status).toBe(409);
    expect(patch.body.code).toBe("subscription_mode");

    const outlook = await request(app)
      .get(`/internal/accounts/by-org/${orgId}/payment-outlook`)
      .set(apiKeyHeaders);
    expect(outlook.body.paymentMode).toBe("subscription");
    expect(outlook.body.state).toBe("no_autopay");
    expect(outlook.body.floorCents).toBe("0");
  });

  it("the hourly settle grants the trial without any read, and forgets an abandoned checkout", async () => {
    await insertTestAccount({ orgId });
    await request(app).post("/v1/accounts/subscription/checkout_session").set(headers).send({});
    subs = [sub()];
    let out = await runSubscriptionSettleSweep();
    expect(out).toEqual({ checked: 1, entered: 1, failed: 0 });
    expect((await account()).paymentMode).toBe("subscription");

    const other = "00000000-0000-0000-0000-0000000005b2";
    await insertTestAccount({ orgId: other });
    await db
      .update(billingAccounts)
      .set({ subscriptionCheckoutStartedAt: new Date(Date.now() - ABANDONED_CHECKOUT_MS - 1000) })
      .where(eq(billingAccounts.orgId, other));
    subs = [];
    out = await runSubscriptionSettleSweep();
    expect(out.checked).toBe(1);
    const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, other));
    expect(row.subscriptionCheckoutStartedAt).toBeNull();
    expect(row.paymentMode).toBe("postpaid");
  });

  it("a second checkout after a past trial gets no trial", async () => {
    await insertTestAccount({ orgId });
    subs = [sub({ status: "canceled" })];
    const res = await request(app).post("/v1/accounts/subscription/checkout_session").set(headers).send({});
    expect(res.status).toBe(200);
    expect(res.body.trial_days).toBeNull();
  });
});
