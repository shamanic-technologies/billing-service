/**
 * SUBSCRIPTION, owned by billing (lib/subscription). Pins the owner's model:
 *   - the customer picks a plan on the ladder and saves a card through the ORDINARY
 *     card setup (Revolut by default); nothing is charged until the trial ends;
 *   - start: 3-day trial, $99 trial credit topped up TO $99, subscription mode;
 *   - at each renewal the unspent credit EXPIRES, then billing charges the plan
 *     (acquirer-neutral charge); replays never expire or charge twice;
 *   - a refused renewal walks the retry rungs (past_due), a dead card ends it;
 *   - plan change up or down from the next charge, not while trialing;
 *   - cancel ends at period end (remainder expires), resume undoes it;
 *   - revenue = the plan, recurring only when active; a trial is shown apart;
 *   - no out-of-credit dunning for a subscription org: the celebratory email instead.
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
  insertTestPromoGrant,
} from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import {
  billingAccounts,
  creditDepletionEpisodes,
  subscriptionCharges,
  subscriptions,
} from "../../src/db/schema.js";
import { settleSignupWelcome } from "../../src/lib/trial-seed.js";
import {
  advanceSubscription,
  getLiveSubscription,
  getLatestSubscription,
  startSubscription,
  settleOrgSubscription,
  ABANDONED_CHECKOUT_MS,
} from "../../src/lib/subscription.js";
import { nextPeriodEnd } from "../../src/lib/subscription-schedule.js";
import { getOrgRevenue } from "../../src/lib/revenue.js";
import { toSubscriptionRecap, type SubscriptionRecap } from "../../src/lib/subscription-recap-client.js";

const orgId = "00000000-0000-0000-0000-0000000005b1";
const userId = "00000000-0000-0000-0000-0000000005b9";
const campaignId = "00000000-0000-0000-0000-0000000005c1";
const apiKeyHeaders = { "X-API-Key": "test-api-key" };
const headers = getAuthHeaders(orgId, userId);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const NO_CARD = {
  object: "saved_payment_method",
  org_id: orgId,
  acquirer: "revolut",
  saved: false,
  method: null,
};
const REVOLUT_CARD = {
  object: "saved_payment_method",
  org_id: orgId,
  acquirer: "revolut",
  saved: true,
  method: { id: "rpm_1", type: "card", saved_for: "merchant" },
};

function recapWithRoi(roi: number | null): SubscriptionRecap {
  return toSubscriptionRecap({
    outbound: { emailsSent: 120, recipientsEnrolled: 60, sendStatus: "emails_sent" },
    expectedPositiveReplies: 3,
    expectedReturn: { roiMultiple: roi },
  });
}

describe("subscription (billing-owned)", () => {
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
    ssMocks.getSavedPaymentMethod.mockResolvedValue(REVOLUT_CARD);
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
    const notifications = await import("../../src/lib/subscription-notifications.js");
    notifications.__resetCreditsUsedSkips();
    const email = await import("../../src/lib/email-client.js");
    sendSpy = vi.fn();
    vi.spyOn(email, "sendEmail").mockImplementation(sendSpy);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  async function account() {
    const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    return row;
  }

  async function startTrial(amount = 19900, now = new Date()) {
    await insertTestAccount({ orgId });
    return startSubscription({ orgId, userId, monthlyAmountCents: amount, now });
  }

  it("checkout: no card yet → the ordinary card form, plan recorded, nothing charged", async () => {
    await insertTestAccount({ orgId });
    ssMocks.getSavedPaymentMethod.mockResolvedValue(NO_CARD);
    const res = await request(app)
      .post("/v1/accounts/subscription/checkout_session")
      .set(headers)
      .send({ monthly_amount_cents: 19900 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      monthly_amount_cents: 19900,
      currency: "usd",
      trial_days: 3,
      card_required: true,
      card_setup: { mode: "embedded_widget", token: "tok_public" },
    });
    const row = await account();
    expect(row.subscriptionRequestedAmountCents).toBe(19900);
    expect(row.subscriptionCheckoutStartedAt).not.toBeNull();
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
    expect(await getLiveSubscription(orgId)).toBeNull();
  });

  it("checkout refuses an off-ladder plan and an existing paying org", async () => {
    await insertTestAccount({ orgId });
    let res = await request(app)
      .post("/v1/accounts/subscription/checkout_session")
      .set(headers)
      .send({ monthly_amount_cents: 2800 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("amount_below_minimum");
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("5000.0000000000");
    res = await request(app).post("/v1/accounts/subscription/checkout_session").set(headers).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("existing_paying_org");
  });

  it("start without a chargeable card → 409 card_required", async () => {
    await insertTestAccount({ orgId });
    ssMocks.authorizeRecurringCharges.mockResolvedValue({ authorized: false, reason: "no_card" });
    const res = await request(app).post("/v1/accounts/subscription/start").set(headers).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("card_required");
  });

  it("start: trialing, subscription mode, $99 trial credit, plan billed at trial end", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 0 });
    await request(app)
      .post("/v1/accounts/subscription/checkout_session")
      .set(headers)
      .send({ monthly_amount_cents: 19900 });
    const res = await request(app).post("/v1/accounts/subscription/start").set(headers).send({});
    expect(res.status).toBe(200);
    expect(res.body.payment_mode).toBe("subscription");
    expect(res.body.trial_grant_cents).toBe(9900);
    expect(res.body.credits_remaining_cents).toBe("9900.0000000000");
    expect(res.body.subscription).toMatchObject({
      status: "trialing",
      monthly_amount_cents: 19900,
      has_payment_method: true,
      can_change_amount: false,
    });
    expect(res.body.subscription.next_charge_at).toBe(res.body.subscription.trial_end);
    const row = await account();
    expect(row.topupAmountCents).toBeNull();
    expect(row.subscriptionCheckoutStartedAt).toBeNull();
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("the read starts a stamped org on its own once the card is saved", async () => {
    await insertTestAccount({ orgId });
    ssMocks.getSavedPaymentMethod.mockResolvedValueOnce(NO_CARD);
    await request(app)
      .post("/v1/accounts/subscription/checkout_session")
      .set(headers)
      .send({ monthly_amount_cents: 29900 });
    const res = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(res.body.subscription).toMatchObject({ status: "trialing", monthly_amount_cents: 29900 });
  });

  it("trial grant tops UP TO $99 (welcome held → +$69); a later welcome adds nothing", async () => {
    await insertTestAccount({ orgId });
    await insertTestPromoGrant({ orgId, userId, amountCents: 3000, promoCode: "welcome" });
    await startSubscription({ orgId, userId });
    const res = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(res.body.trial_grant_cents).toBe(6900);
    expect(res.body.credits_remaining_cents).toBe("9900.0000000000");
    expect((await settleSignupWelcome(orgId, null)).welcomeGrantedCents).toBe(0);
  });

  it("trial end: unspent credit expires, THEN the plan is charged; a replay does neither twice", async () => {
    const sub = await startTrial(19900);
    setUsage("3000.0000000000"); // $30 spent during the trial → $69 unspent
    const t = new Date(sub.currentPeriodEnd.getTime() + HOUR);
    const after = await advanceSubscription(sub, t);

    expect(after.status).toBe("active");
    expect(after.currentPeriodStart.getTime()).toBe(sub.currentPeriodEnd.getTime());
    expect(after.currentPeriodEnd.getTime()).toBe(
      nextPeriodEnd(sub.currentPeriodEnd, sub.trialEndsAt!).getTime()
    );
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(19900);

    // stripe-service now counts the charge as a paid top-up.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("19900.0000000000");
    await advanceSubscription((await getLiveSubscription(orgId))!, t);
    await settleOrgSubscription(orgId, t);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);

    // A PAID trial end expires nothing: the $69 left of the trial is the first
    // month's credit. The $199 payment repays the $99 trial credit (adds none for
    // it) and adds the other $100: balance = $69 + $100.
    const acct = await request(app).get("/v1/accounts").set(headers);
    expect(Number(acct.body.expired_cents)).toBe(0);
    expect(acct.body.credited_trial_repaid_cents).toBe("9900.0000000000");
    expect(acct.body.credited_cents).toBe("19900.0000000000");
    expect(acct.body.balance_cents).toBe("16900.0000000000");
  });

  it("the trial-end payment repays the trial and adds NO credit; staff gifts stay; month 2 adds credit (Legistai 2026-10-06)", async () => {
    await insertTestAccount({ orgId });
    await insertTestPromoGrant({ orgId, userId, amountCents: 3000, promoCode: "trial_seed" });
    const sub = await startSubscription({ orgId, userId, monthlyAmountCents: 9900 });
    await insertTestPromoGrant({ orgId, userId, amountCents: 500, promoCode: "admin_grant" });
    setUsage("8973.0000000000");

    const t = new Date(sub.currentPeriodEnd.getTime() + HOUR);
    const after = await advanceSubscription(sub, t);
    expect(after.status).toBe("active");
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("9900.0000000000");

    // $30 seed + $69 trial + $5 staff = $104. The $99 payment adds $0.
    const acct = await request(app).get("/v1/accounts").set(headers);
    expect(acct.body.credited_cents).toBe("10400.0000000000");
    expect(acct.body.credited_trial_repaid_cents).toBe("9900.0000000000");
    expect(acct.body.credited_paid_cents).toBe("0.0000000000");
    expect(acct.body.credited_gifted_cents).toBe("10400.0000000000");
    expect(Number(acct.body.expired_cents)).toBe(0);
    expect(acct.body.balance_cents).toBe("1427.0000000000");

    // The 2nd period's charge is an ordinary payment: it adds its $99.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("19800.0000000000");
    const month2 = await request(app).get("/v1/accounts").set(headers);
    expect(month2.body.credited_cents).toBe("20300.0000000000");
  });

  it("a trial cancelled before any payment keeps its trial credit (nothing repaid)", async () => {
    await startTrial(9900);
    const acct = await request(app).get("/v1/accounts").set(headers);
    expect(acct.body.credited_trial_repaid_cents).toBe("0.0000000000");
    expect(acct.body.credited_cents).toBe("9900.0000000000");
  });

  it("an overspent balance never expires", async () => {
    const sub = await startTrial();
    setUsage("12000.0000000000"); // balance −21 dollars
    await advanceSubscription(sub, new Date(sub.currentPeriodEnd.getTime() + HOUR));
    const acct = await request(app).get("/v1/accounts").set(headers);
    expect(Number(acct.body.expired_cents)).toBe(0);
  });

  it("a refused renewal goes past_due and is retried on the next rung; then active", async () => {
    const sub = await startTrial();
    ssMocks.reloadOffSession.mockResolvedValueOnce({ status: "failed", failure_code: "insufficient_funds" });
    const t1 = new Date(sub.currentPeriodEnd.getTime() + HOUR);
    const pastDue = await advanceSubscription(sub, t1);
    expect(pastDue.status).toBe("past_due");

    await advanceSubscription(pastDue, new Date(t1.getTime() + 2 * HOUR));
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);

    const again = await advanceSubscription(pastDue, new Date(t1.getTime() + DAY + HOUR));
    expect(again.status).toBe("active");
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(2);
    expect(ssMocks.reloadOffSession.mock.calls[0][2]).not.toBe(ssMocks.reloadOffSession.mock.calls[1][2]);
  });

  it("a renewal recorded refused whose payment in fact SUCCEEDED is reconciled to paid, never charged again (2026-10-06)", async () => {
    const sub = await startTrial();
    // stripe-service reported an in-flight Revolut payment as a decline; the
    // order completed two seconds later.
    ssMocks.reloadOffSession.mockResolvedValueOnce({
      status: "failed",
      reference: "rev-ord-1",
      failure_code: "declined",
    });
    const t1 = new Date(sub.currentPeriodEnd.getTime() + HOUR);
    const pastDue = await advanceSubscription(sub, t1);
    expect(pastDue.status).toBe("past_due");

    ssMocks.listOrgPayments.mockResolvedValue([
      { id: "rev-ord-1", acquirer: "revolut", amount: 19900, currency: "usd", status: "succeeded", created: 1 },
    ]);
    // Well before the next rung: the reconcile does not wait for it.
    const healed = await advanceSubscription(pastDue, new Date(t1.getTime() + HOUR));

    expect(healed.status).toBe("active");
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    const [row] = await db
      .select()
      .from(subscriptionCharges)
      .where(eq(subscriptionCharges.subscriptionId, sub.id));
    expect(row.status).toBe("paid");
    expect(row.reference).toBe("rev-ord-1");

    // And on the day the next rung would have fired, still no second charge.
    await advanceSubscription(healed, new Date(t1.getTime() + DAY + HOUR));
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
  });

  it("a refused renewal whose payment is still in flight, or unreadable, is NOT retried", async () => {
    const sub = await startTrial();
    ssMocks.reloadOffSession.mockResolvedValueOnce({
      status: "failed",
      reference: "rev-ord-2",
      failure_code: "declined",
    });
    const t1 = new Date(sub.currentPeriodEnd.getTime() + HOUR);
    const pastDue = await advanceSubscription(sub, t1);

    ssMocks.listOrgPayments.mockResolvedValueOnce([
      { id: "rev-ord-2", acquirer: "revolut", amount: 19900, currency: "usd", status: "pending", created: 1 },
    ]);
    const held = await advanceSubscription(pastDue, new Date(t1.getTime() + DAY + HOUR));
    expect(held.status).toBe("past_due");

    ssMocks.listOrgPayments.mockRejectedValueOnce(new Error("stripe-service down"));
    await advanceSubscription(held, new Date(t1.getTime() + DAY + 2 * HOUR));
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);

    // A payment the mirror says FAILED walks the ordinary rung.
    ssMocks.listOrgPayments.mockResolvedValueOnce([
      { id: "rev-ord-2", acquirer: "revolut", amount: 19900, currency: "usd", status: "failed", created: 1 },
    ]);
    await advanceSubscription(held, new Date(t1.getTime() + DAY + 3 * HOUR));
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(2);
  });

  it("a card the bank called stolen ends the subscription", async () => {
    const sub = await startTrial();
    ssMocks.reloadOffSession.mockResolvedValueOnce({ status: "failed", failure_code: "stolen_card" });
    const ended = await advanceSubscription(sub, new Date(sub.currentPeriodEnd.getTime() + HOUR));
    expect(ended.status).toBe("canceled");
  });

  it("an outage consumes no rung and is retried next tick", async () => {
    const sub = await startTrial();
    ssMocks.reloadOffSession.mockRejectedValueOnce(new Error("stripe-service POST /x failed: 503 down"));
    const t = new Date(sub.currentPeriodEnd.getTime() + HOUR);
    const still = await advanceSubscription(sub, t);
    expect(still.status).toBe("trialing");
    const [charge] = await db.select().from(subscriptionCharges).where(eq(subscriptionCharges.orgId, orgId));
    expect(charge.attemptCount).toBe(0);
    const next = await advanceSubscription(still, new Date(t.getTime() + HOUR));
    expect(next.status).toBe("active");
  });

  it("plan change: refused while trialing; any ladder value up or down once active; next renewal charges it", async () => {
    const sub = await startTrial(29900, new Date(Date.now() - 4 * DAY));
    let res = await request(app).patch("/v1/accounts/subscription").set(headers).send({ monthly_amount_cents: 9900 });
    // The read advances the trial (it ended a day ago) before deciding.
    expect(res.status).toBe(200);
    expect(res.body.subscription.monthly_amount_cents).toBe(9900);
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(29900);

    res = await request(app).patch("/v1/accounts/subscription").set(headers).send({ monthly_amount_cents: 15050 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("amount_not_whole_dollars");
    res = await request(app).patch("/v1/accounts/subscription").set(headers).send({ monthly_amount_cents: 9900 });
    expect(res.body.code).toBe("amount_unchanged");

    const changed = (await getLiveSubscription(orgId))!;
    await advanceSubscription(changed, new Date(changed.currentPeriodEnd.getTime() + HOUR));
    expect(ssMocks.reloadOffSession.mock.calls.at(-1)![1]).toBe(9900);
    expect(sub.monthlyAmountCents).toBe(29900);
  });

  it("plan change is refused while trialing", async () => {
    await startTrial();
    const res = await request(app).patch("/v1/accounts/subscription").set(headers).send({ monthly_amount_cents: 29900 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("subscription_trialing");
  });

  it("cancel at period end: no further charge, remainder expires; resume undoes it", async () => {
    const sub = await startTrial();
    let res = await request(app).post("/v1/accounts/subscription/cancel").set(headers);
    expect(res.status).toBe(200);
    expect(res.body.subscription.cancel_at_period_end).toBe(true);
    expect(res.body.subscription.next_charge_at).toBeNull();
    res = await request(app).post("/v1/accounts/subscription/resume").set(headers);
    expect(res.body.subscription.cancel_at_period_end).toBe(false);
    res = await request(app).post("/v1/accounts/subscription/resume").set(headers);
    expect(res.body.code).toBe("subscription_not_cancel_pending");

    await request(app).post("/v1/accounts/subscription/cancel").set(headers);
    setUsage("1000.0000000000");
    const ended = await advanceSubscription(
      (await getLiveSubscription(orgId))!,
      new Date(sub.currentPeriodEnd.getTime() + HOUR)
    );
    expect(ended.status).toBe("canceled");
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
    const read = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(read.body.expired_cents).toBe("8900.0000000000");
    expect(read.body.credits_remaining_cents).toBe("0.0000000000");
    expect(read.body.subscription.status).toBe("canceled");
  });

  it("revenue: active = the plan as MRR; trialing shown apart; cancel pending = 0", async () => {
    const sub = await startTrial(19900);
    let rev = await getOrgRevenue(orgId);
    expect(rev!.revenueClass).toBe("none");
    expect(rev!.classReason).toBe("subscription_trialing");
    expect(rev!.subscription!.monthlyAmountCents).toBe(19900);
    expect(rev!.cash.events[0]).toMatchObject({ trigger: "subscription_renewal", expectedAmountCents: "19900" });

    const t = new Date(sub.currentPeriodEnd.getTime() + HOUR);
    await advanceSubscription(sub, t);
    rev = await getOrgRevenue(orgId, 90, new Date(t.getTime() + HOUR));
    expect(rev!.revenueClass).toBe("recurring");
    expect(rev!.classReason).toBe("subscription");
    expect(rev!.mrrCents).toBe("19900.0000000000");
    expect(rev!.cash.events.length).toBeGreaterThan(0);
    expect(rev!.cash.events.every((e) => e.expectedAmountCents === "19900")).toBe(true);

    await db.update(subscriptions).set({ cancelAtPeriodEnd: true }).where(eq(subscriptions.orgId, orgId));
    rev = await getOrgRevenue(orgId, 90, new Date(t.getTime() + HOUR));
    expect(rev!.classReason).toBe("subscription_canceling");
    expect(rev!.mrrCents).toBe("0.0000000000");
  });

  it("outlook: the next charge is the renewal", async () => {
    const sub = await startTrial();
    const res = await request(app)
      .get(`/internal/accounts/by-org/${orgId}/payment-outlook`)
      .set(apiKeyHeaders);
    expect(res.body.state).toBe("will_charge");
    expect(res.body.trigger).toBe("subscription_renewal");
    expect(res.body.nextChargeAttemptAt).toBe(sub.currentPeriodEnd.toISOString());
  });

  it("out of credit: no depletion episode, the celebratory email once per period", async () => {
    await startTrial();
    setUsage("9900.0000000000");
    await insertTestCampaignCost({ campaignId, orgId, lastAuthorizeRequiredCents: "50.0000000000" });
    const auth = await request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...headers, "x-campaign-id": campaignId })
      .send({ items: [{ costName: "anthropic-sonnet-4-5-tokens-input", quantity: 1000 }] });
    expect(auth.body.sufficient).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    const episodes = await db
      .select()
      .from(creditDepletionEpisodes)
      .where(eq(creditDepletionEpisodes.orgId, orgId));
    expect(episodes).toHaveLength(0);

    const { notifySubscriptionCreditsUsedIfDue } = await import(
      "../../src/lib/subscription-notifications.js"
    );
    await notifySubscriptionCreditsUsedIfDue(orgId, await getLiveSubscription(orgId));
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = sendSpy.mock.calls[0][0];
    expect(sent.eventType).toBe("subscription-credits-used");
    expect(sent.metadata.ctaUrl).toBe("https://dashboard.distribute.you/orgs/org_clerk1/billing");
    expect(JSON.stringify(sent.metadata)).not.toMatch(/exhaust|used up|run out|ran out/i);
  });

  async function useUpAndNotify() {
    const { notifySubscriptionCreditsUsedIfDue } = await import(
      "../../src/lib/subscription-notifications.js"
    );
    await notifySubscriptionCreditsUsedIfDue(orgId, await getLiveSubscription(orgId));
  }

  async function claimedPeriod() {
    return (await getLiveSubscription(orgId))!.creditsUsedNotifiedPeriodStart;
  }

  it.each([
    ["0.35x", 0.35],
    ["exactly 1.0x", 1],
    ["unknown", null],
  ])("month-booked upsell email: an expected return of %s is NOT sent and leaves the period unclaimed", async (_l, roi) => {
    await startTrial();
    setUsage("9900.0000000000");
    recapSpy.mockResolvedValue(recapWithRoi(roi));
    const warn = vi.spyOn(console, "warn");
    await useUpAndNotify();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(await claimedPeriod()).toBeNull();
    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes("credits-used email skipped"));
    expect(line).toMatch(/^\[billing-service\]/);
    expect(line).toContain(orgId);
    expect(line).toContain(roi === null ? "unknown" : `${roi}x`);
  });

  it("month-booked upsell email: an unreadable recap is NOT sent", async () => {
    await startTrial();
    setUsage("9900.0000000000");
    recapSpy.mockResolvedValue(null);
    await useUpAndNotify();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(await claimedPeriod()).toBeNull();
  });

  it("month-booked upsell email: a skip leaves the period open, a later run above 1x sends once", async () => {
    const sub = await startTrial();
    setUsage("9900.0000000000");
    recapSpy.mockResolvedValue(recapWithRoi(0.35));
    await useUpAndNotify();
    expect(sendSpy).not.toHaveBeenCalled();

    // Within the throttle window the return is not re-read.
    recapSpy.mockClear();
    await useUpAndNotify();
    expect(recapSpy).not.toHaveBeenCalled();

    // Next sweep (throttle elapsed): the return is now above 1x, so it goes out.
    const { __resetCreditsUsedSkips } = await import("../../src/lib/subscription-notifications.js");
    __resetCreditsUsedSkips();
    recapSpy.mockResolvedValue(recapWithRoi(1.2));
    await useUpAndNotify();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0].metadata.bodyHtml).toContain("1.2x");
    expect((await claimedPeriod())!.getTime()).toBe(sub.currentPeriodStart.getTime());

    await useUpAndNotify();
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("staff can set subscription; the customer switch cannot; staff leaving ends the subscription", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 200 });
    let res = await request(app).put("/v1/accounts/payment_mode").set(headers).send({ payment_mode: "subscription" });
    expect(res.status).toBe(400);
    res = await request(app)
      .put(`/internal/accounts/by-org/${orgId}/payment-mode`)
      .set(apiKeyHeaders)
      .send({ payment_mode: "subscription" });
    expect(res.body).toMatchObject({ payment_mode: "subscription", auto_topup_enabled: false });
    res = await request(app).put("/v1/accounts/payment_mode").set(headers).send({ payment_mode: "prepaid" });
    expect(res.body.code).toBe("subscription_mode_staff_only");

    await startSubscription({ orgId, userId });
    res = await request(app)
      .put(`/internal/accounts/by-org/${orgId}/payment-mode`)
      .set(apiKeyHeaders)
      .send({ payment_mode: "prepaid" });
    expect(res.status).toBe(200);
    expect(await getLiveSubscription(orgId)).toBeNull();
    expect((await getLatestSubscription(orgId))!.status).toBe("canceled");
  });

  it("an abandoned checkout is forgotten after 48h; a second subscription gets no trial and is charged at start", async () => {
    await insertTestAccount({ orgId });
    ssMocks.getSavedPaymentMethod.mockResolvedValue(NO_CARD);
    await request(app).post("/v1/accounts/subscription/checkout_session").set(headers).send({});
    await settleOrgSubscription(orgId, new Date(Date.now() + ABANDONED_CHECKOUT_MS + HOUR));
    expect((await account()).subscriptionCheckoutStartedAt).toBeNull();

    ssMocks.getSavedPaymentMethod.mockResolvedValue(REVOLUT_CARD);
    const first = await startSubscription({ orgId, userId });
    await request(app).post("/v1/accounts/subscription/cancel").set(headers);
    await advanceSubscription(
      (await getLiveSubscription(orgId))!,
      new Date(first.currentPeriodEnd.getTime() + HOUR)
    );

    const res = await request(app).post("/v1/accounts/subscription/checkout_session").set(headers).send({});
    expect(res.body.trial_days).toBeNull();
    const second = await startSubscription({ orgId, userId });
    expect(second.status).toBe("active");
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
  });
});
