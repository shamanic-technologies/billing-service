/**
 * The SOLO-FOUNDER plan (SOLO-PLAN-1125, lib/solo-plan), on a staff test org:
 *   - free: a debt of at most $2 on our keys, no campaign on our keys;
 *   - start without a card -> the card page link; prepaid card refused;
 *   - start with a debit card -> $99 hold, 3-day trial capped at $10;
 *   - trial end -> the hold captured, debt deducted ($2 owed, $99 paid -> $97);
 *   - +$100 layer mid-cycle -> $199 − unspent charged, cycle restarts today;
 *   - out of credit served, campaigns refused;
 *   - cycle end -> unspent credit expires, the plan renews;
 *   - existing accounts unchanged (enrol refused, authorize as before).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail, mockCardHold } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { billingAccounts, soloPlanCharges, subscriptionCreditExpiries } from "../../src/db/schema.js";
import { addSoloPlanLayer, getSoloPlan, settleSoloPlan } from "../../src/lib/solo-plan.js";

const orgId = "a0000000-0000-4000-8000-0000000501a1";
const userId = "a0000000-0000-4000-8000-0000000501a9";
const campaignId = "a0000000-0000-4000-8000-0000000501c1";
const headers = getAuthHeaders(orgId, userId);
const DAY = 86400_000;

function card(prepaid: boolean | null) {
  return {
    object: "saved_payment_method",
    org_id: orgId,
    acquirer: "stripe",
    saved: true,
    method: { id: "pm_solo", type: "card", saved_for: "merchant", funding: prepaid ? "prepaid" : "debit", prepaid },
  };
}
const NO_CARD = { object: "saved_payment_method", org_id: orgId, acquirer: "stripe", saved: false, method: null, reason: "none" };

describe("solo-founder plan", () => {
  const app = createTestApp();
  let ss: ReturnType<typeof setupStripeMocks>;
  let usage = "0";
  let paid = "0";

  function setUsage(cents: number) {
    usage = new Number(cents).toFixed(10);
  }
  function setPaid(cents: number) {
    paid = new Number(cents).toFixed(10);
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    usage = "0.0000000000";
    paid = "0.0000000000";
    ss = setupStripeMocks();
    ss.fetchOrgCustomer.mockResolvedValue(customerWithEmail("kevin.lourd+solo@gmail.com"));
    ss.sumSucceededTopupsForOrg.mockImplementation(async () => paid);
    ss.hasChargeablePmForOrg.mockResolvedValue(true);
    ss.getOrgCardCountryByOrg.mockResolvedValue("US");
    ss.getSavedPaymentMethod.mockResolvedValue(NO_CARD);
    ss.placeCardHold.mockImplementation(async (_o: string, body: { amount: number; metadata?: Record<string, string> }) =>
      mockCardHold({ id: "hold_solo_1", amount: body.amount, metadata: body.metadata ?? null })
    );

    const runs = await import("../../src/lib/runs-client.js");
    vi.spyOn(runs, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({ org_id: orgId, spent_cents: usage, as_of: "x" }));
    vi.spyOn(runs, "fetchRunsOrgActualUsageTotal").mockImplementation(async () => ({ org_id: orgId, spent_cents: usage, as_of: "x" }));
    vi.spyOn(runs, "createPlatformRun").mockResolvedValue("00000000-0000-4000-8000-00000000a001");
    vi.spyOn(runs, "completePlatformRun").mockResolvedValue(undefined);
    const costs = await import("../../src/lib/costs-client.js");
    vi.spyOn(costs, "resolveRequiredCents").mockResolvedValue("50.0000000000");
    const email = await import("../../src/lib/email-client.js");
    vi.spyOn(email, "sendEmail").mockImplementation(vi.fn());
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  async function authorize(withCampaign: boolean) {
    const h = withCampaign ? { ...headers, "x-campaign-id": campaignId } : headers;
    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(h)
      .send({ items: [{ costName: "anthropic-sonnet-tokens-input", quantity: 1 }] });
    expect(res.status).toBe(200);
    return res.body.sufficient as boolean;
  }

  async function state() {
    const res = await request(app).get(`/internal/accounts/by-org/${orgId}/solo-plan`).set(headers);
    expect(res.status).toBe(200);
    return res.body;
  }

  it("walks free -> trial -> paid -> layer -> out of credit -> renewal", async () => {
    await insertTestAccount({ orgId, freeCreditOffer: "prepaid_at_cost", paymentMode: "prepaid" });

    // FREE: enrol. The $2 is a debt we accept, never credit.
    const enrol = await request(app).post("/v1/accounts/solo_plan/enroll").set(headers).send({});
    expect(enrol.status).toBe(200);
    expect(enrol.body.plan).toBe("free");
    expect(enrol.body.debt_limit_cents).toBe(200);
    expect(enrol.body.credit_left_cents).toBe("0.0000000000");
    const [acct] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(acct.freeCreditOffer).toBe("solo_founder");

    // Conversation runs down to -$2, not past it.
    setUsage(150);
    expect(await authorize(false)).toBe(true); // -150 - 50 = -200
    setUsage(151);
    expect(await authorize(false)).toBe(false);
    // A campaign needs the paid plan, room left or not.
    setUsage(0);
    expect(await authorize(true)).toBe(false);
    expect((await state()).may_launch_campaign_on_our_keys).toBe(false);

    // START without a card -> the card page link.
    setUsage(200); // owes $2
    let res = await request(app)
      .post("/v1/accounts/solo_plan/start")
      .set(headers)
      .send({ return_url: "https://lab.distribute.you/billing" });
    expect(res.status).toBe(200);
    expect(res.body.card_required).toBe(true);
    expect(res.body.checkout_url).toBe("https://billing.stripe.com/p/session/abc");
    expect(ss.placeCardHold).not.toHaveBeenCalled();

    // Card saved -> $99 hold, 3-day trial.
    ss.getSavedPaymentMethod.mockResolvedValue(card(false));
    res = await request(app)
      .post("/v1/accounts/solo_plan/start")
      .set(headers)
      .send({ return_url: "https://lab.distribute.you/billing" });
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe("trialing");
    expect(res.body.trial_hold_cents).toBe(9900);
    expect(res.body.trial_spend_cap_cents).toBe(1000);
    expect(ss.placeCardHold).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ amount: 9900, metadata: expect.objectContaining({ billing_purpose: "solo_plan_trial" }) }),
      expect.any(String)
    );
    expect(ss.reloadOffSession).not.toHaveBeenCalled();

    // $10 cap in the trial: from -$2 down to -$12.
    expect(await authorize(true)).toBe(true);
    setUsage(1150);
    expect(await authorize(true)).toBe(true); // -1150 - 50 = -1200
    setUsage(1160);
    expect(await authorize(true)).toBe(false);
    setUsage(1200);
    const capped = await state();
    expect(capped.out_of_credit).toBe(true);
    expect(capped.out_of_credit_reason).toBe("trial_cap_reached");
    expect(capped.next_step.action).toBe("start_paid_now");

    // TRIAL END -> hold captured for $99; owes $2 -> starts with $97.
    setUsage(200);
    const plan = (await getSoloPlan(orgId))!;
    const trialEnd = plan.trialEndsAt!;
    await settleSoloPlan(orgId, new Date(trialEnd.getTime() + 60_000));
    expect(ss.captureCardHold).toHaveBeenCalledWith(orgId, "hold_solo_1", 9900);
    expect(ss.reloadOffSession).not.toHaveBeenCalled();
    setPaid(9900);
    const active = await state();
    expect(active.plan).toBe("active");
    expect(active.balance_cents).toBe("9700.0000000000");
    expect(active.credit_left_cents).toBe("9700.0000000000");
    expect(active.current_period_start).toBe(trialEnd.toISOString());
    expect(active.may_launch_campaign_on_our_keys).toBe(true);

    // LAYER on day 11 of the cycle: $40 spent, $59 unspent -> pays $199 − $59 = $140.
    setUsage(4000);
    const layerAt = new Date(trialEnd.getTime() + 11 * DAY);
    const layer = await addSoloPlanLayer(orgId, layerAt);
    expect(layer.chargedCents).toBe(14000);
    expect(layer.unspentDiscountCents).toBe(5900);
    expect(ss.reloadOffSession).toHaveBeenCalledWith(orgId, 14000, expect.any(String), expect.objectContaining({ reason: "solo_plan" }));
    expect(layer.plan.monthlyAmountCents).toBe(19900);
    expect(layer.plan.currentPeriodStart!.toISOString()).toBe(layerAt.toISOString());
    const nextMonth = new Date(layerAt);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    expect(layer.plan.currentPeriodEnd!.toISOString()).toBe(nextMonth.toISOString());
    setPaid(9900 + 14000);
    expect((await state()).balance_cents).toBe("19900.0000000000");

    // OUT OF CREDIT: campaigns stop, the next step is a layer.
    setUsage(23900);
    const out = await state();
    expect(out.out_of_credit).toBe(true);
    expect(out.out_of_credit_reason).toBe("credit_used_up");
    expect(out.may_launch_campaign_on_our_keys).toBe(false);
    expect(out.next_step).toEqual({ action: "add_layer", method: "POST", path: "/v1/accounts/solo_plan/layers", amount_cents: 29900 });
    expect(await authorize(true)).toBe(false);
    const aff = await request(app).get(`/internal/campaigns/${campaignId}/affordability`).set(headers);
    expect(aff.body.affordable).toBe(false);

    // CYCLE END: $49 unspent expires, $199 charged.
    setUsage(23900 - 4900);
    ss.reloadOffSession.mockClear();
    await settleSoloPlan(orgId, new Date(nextMonth.getTime() + 60_000));
    const [expiry] = await db.select().from(subscriptionCreditExpiries).where(eq(subscriptionCreditExpiries.orgId, orgId));
    expect(expiry.amountCents).toBe("4900.0000000000");
    expect(ss.reloadOffSession).toHaveBeenCalledWith(orgId, 19900, expect.any(String), expect.anything());
    setPaid(9900 + 14000 + 19900);
    const renewed = await state();
    expect(renewed.balance_cents).toBe("19900.0000000000");
    expect(renewed.current_period_start).toBe(nextMonth.toISOString());
    const charges = await db.select().from(soloPlanCharges).where(eq(soloPlanCharges.orgId, orgId));
    expect(charges.map((c) => [c.kind, c.amountCents, c.status]).sort()).toEqual(
      [
        ["layer", 14000, "paid"],
        ["renewal", 19900, "paid"],
        ["trial_conversion", 9900, "paid"],
      ].sort()
    );
  });

  it("a prepaid card is refused at trial start, no hold taken", async () => {
    await insertTestAccount({ orgId, freeCreditOffer: "prepaid_at_cost", paymentMode: "prepaid" });
    ss.getSavedPaymentMethod.mockResolvedValue(card(true));
    const res = await request(app)
      .post("/v1/accounts/solo_plan/start")
      .set(headers)
      .send({ return_url: "https://lab.distribute.you/billing" });
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe("free");
    expect(res.body.card_required).toBe(true);
    expect(res.body.card_refused_reason).toBe("prepaid_card");
    expect(ss.placeCardHold).not.toHaveBeenCalled();
  });

  it("a refused $99 hold starts nothing", async () => {
    await insertTestAccount({ orgId, freeCreditOffer: "prepaid_at_cost", paymentMode: "prepaid" });
    ss.getSavedPaymentMethod.mockResolvedValue(card(false));
    ss.placeCardHold.mockResolvedValue(
      mockCardHold({ status: "refused", amount: 9900, failure: { type: "card_error", code: "insufficient_funds", message: "Your card has insufficient funds." } })
    );
    const res = await request(app)
      .post("/v1/accounts/solo_plan/start")
      .set(headers)
      .send({ return_url: "https://lab.distribute.you/billing" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("card_hold_refused");
    expect((await getSoloPlan(orgId))!.status).toBe("free");
  });

  it("an org with no billing account is enrolled with no $5 advance", async () => {
    const res = await request(app).post(`/internal/accounts/by-org/${orgId}/solo-plan/enroll`).set(headers).send({});
    expect(res.status).toBe(200);
    expect(res.body.balance_cents).toBe("0.0000000000");
    const signup = await request(app).post(`/internal/accounts/by-org/${orgId}/org-creation-bonus`).set(headers).send({});
    expect([200, 409]).toContain(signup.status);
    expect((await state()).balance_cents).toBe("0.0000000000");
  });

  it("AI gate: not on the plan -> on_solo_plan false; free -> refused once the $2 debt is reached", async () => {
    await insertTestAccount({ orgId, freeCreditOffer: "prepaid_at_cost", paymentMode: "prepaid" });
    let gate = await request(app).get(`/internal/accounts/by-org/${orgId}/solo-plan/ai-gate`).set(headers);
    expect(gate.status).toBe(200);
    expect(gate.body.on_solo_plan).toBe(false);
    expect(gate.body.may_use_our_keys).toBe(true);

    process.env.SOLO_PLAN_PUBLIC_BASE_URL = "https://api.distribute.you";
    try {
      await request(app).post("/v1/accounts/solo_plan/enroll").set(headers).send({});
      setUsage(150);
      gate = await request(app).get(`/internal/accounts/by-org/${orgId}/solo-plan/ai-gate`).set(headers);
      expect(gate.body).toMatchObject({
        on_solo_plan: true,
        plan: "free",
        may_use_our_keys: true,
        debt_cents: "150.0000000000",
        debt_limit_cents: 200,
      });
      setUsage(200);
      gate = await request(app).get(`/internal/accounts/by-org/${orgId}/solo-plan/ai-gate`).set(headers);
      expect(gate.body.may_use_our_keys).toBe(false);
      expect(gate.body.refused_reason).toBe("debt_limit_reached");
      expect(gate.body.next_step.action).toBe("start_plan");
      expect(gate.body.upgrade_url).toMatch(/^https:\/\/api\.distribute\.you\/public\/solo-plan\/pay\/[\w-]+\.[\w-]+$/);
      expect(gate.body.pay_link_path).toMatch(/^\/public\/solo-plan\/pay\//);
    } finally {
      delete process.env.SOLO_PLAN_PUBLIC_BASE_URL;
    }
  });

  it("existing accounts keep their offer: enrol refused, authorize unchanged", async () => {
    await insertTestAccount({ orgId }); // legacy
    const res = await request(app).post("/v1/accounts/solo_plan/enroll").set(headers).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("offer_not_switchable");
    expect((await request(app).get(`/internal/accounts/by-org/${orgId}/solo-plan`).set(headers)).status).toBe(404);
    // No-campaign spend stays the platform's, whatever the balance.
    setUsage(100000);
    expect(await authorize(false)).toBe(true);
    const [acct] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(acct.freeCreditOffer).toBe("legacy");
  });

  it("an at-cost org that already paid keeps its offer", async () => {
    await insertTestAccount({ orgId, freeCreditOffer: "prepaid_at_cost", paymentMode: "prepaid" });
    setPaid(1000);
    const res = await request(app).post("/v1/accounts/solo_plan/enroll").set(headers).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("existing_paying_org");
  });
});
