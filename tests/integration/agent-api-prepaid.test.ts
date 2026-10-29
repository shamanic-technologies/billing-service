/**
 * Orgs opened by an AI agent through the API (owner 2026-10-12): no free credit of
 * any kind, prepaid with a MANDATORY auto top-up, set up in ONE call.
 *
 * Worked example: pay $10 -> balance $10, auto top-up $15 below $5. The balance falls
 * under $5 -> the card is charged $15. Never any free credit row.
 *
 * Own file: other suites close the shared connection in `afterAll` (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi, beforeAll } from "vitest";
import { useMatchOfferDefaults, restoreCurrentOfferDefaults } from "../helpers/test-db.js";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import * as runsClient from "../../src/lib/runs-client.js";
import * as costsClient from "../../src/lib/costs-client.js";
import { db } from "../../src/db/index.js";
import { billingAccounts, localPromos, subscriptions } from "../../src/db/schema.js";

const orgId = "00000000-0000-0000-0000-0000000007a1";
const unmarkedOrgId = "00000000-0000-0000-0000-0000000007a2";
const person = "11111111-1111-4111-8111-1111111117a1";
const internal = { "X-API-Key": "test-api-key" };
const cents = (n: number) => `${n}.0000000000`;

const checkoutBody = {
  topup_amount_cents: 1000,
  auto_topup_amount_cents: 1500,
  auto_topup_threshold_cents: 500,
  success_url: "https://distribute.you/ok",
  cancel_url: "https://distribute.you/cancel",
};

async function promoRows(id: string) {
  return db.select().from(localPromos).where(eq(localPromos.orgId, id));
}

describe("Agent/API orgs: prepaid with mandatory auto top-up, no free credit", () => {
  const app = createTestApp();
  let ss: ReturnType<typeof setupStripeMocks>;
  let usage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ss = setupStripeMocks();
    await cleanTestData();
    usage = vi.fn().mockResolvedValue({ spent_cents: "0.0000000000" });
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(usage as never);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(usage as never);
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue("10.0000000000");
    ss.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
  });

  // Written against a fresh account of the match_100 era (pre-0093).
  beforeAll(async () => {
    await useMatchOfferDefaults();
  });

  afterAll(async () => {
    await restoreCurrentOfferDefaults();
    await cleanTestData();
    await closeDb();
  });

  const mark = (id = orgId) =>
    request(app).put(`/internal/accounts/by-org/${id}/agent-api-signup`).set(internal);

  it("marking creates the account with no free credit, prepaid; a second call is a no-op", async () => {
    const res = await mark();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      orgId,
      freeCreditOffer: "agent_api",
      paymentMode: "prepaid",
      created: true,
      alreadyMarked: false,
      freeCreditHeldCents: "0",
    });
    const again = await mark();
    expect(again.body).toMatchObject({ created: false, alreadyMarked: true });

    // The first ordinary billing touch afterwards grants nothing.
    const account = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId, person));
    expect(account.status).toBe(200);
    expect(account.body.credited_cents).toBe(cents(0));
    expect(account.body.balance_cents).toBe(cents(0));
    expect(account.body.free_credit_offer).toBe("agent_api");
    expect(account.body.free_credit_entitlement_cents).toBe(0);
    expect(account.body.free_credit_pending_cents).toBe(cents(0));
    expect(await promoRows(orgId)).toHaveLength(0);
  });

  it("every automatic free-credit path refuses or grants nothing", async () => {
    await mark();
    const bonus = await request(app)
      .post(`/internal/accounts/by-org/${orgId}/org-creation-bonus`)
      .set(internal);
    expect(bonus.status).toBe(409);
    expect(bonus.body.code).toBe("free_credit_not_offered");

    const seed = await request(app).post(`/internal/accounts/by-org/${orgId}/trial-seed`).set(internal);
    expect(seed.status).toBe(409);
    expect(seed.body.code).toBe("free_credit_not_offered");

    const signup = await request(app)
      .post(`/internal/accounts/by-org/${orgId}/signup`)
      .set({ ...internal, "x-user-id": person });
    expect(signup.status).toBe(200);
    expect(signup.body).toMatchObject({ welcomeGrantedCents: 0, totalFreeCreditCents: 0 });

    const redeem = await request(app)
      .post("/v1/promotion_codes/redeem")
      .set(getAuthHeaders(orgId, person))
      .send({ code: "welcome" });
    expect(redeem.status).toBe(409);
    expect(redeem.body.code).toBe("free_credit_not_offered");

    const invite = await request(app)
      .post("/internal/credits/grant")
      .set(internal)
      .send({ orgId, amountCents: 2500, reason: "invite_welcome" });
    expect(invite.status).toBe(409);
    expect(invite.body.code).toBe("free_credit_not_offered");

    expect(await promoRows(orgId)).toHaveLength(0);
  });

  it("a $0 agent org's spend authorization fails clearly (sufficient:false), nothing granted", async () => {
    await mark();
    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId, person), "x-campaign-id": "00000000-0000-0000-0000-00000000ca01" })
      .send({ items: [{ costName: "anthropic-sonnet-4-5-tokens-input", quantity: 1000 }], description: "agent spend" });
    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
    expect(res.body.balance_cents).toBe(cents(0));
    expect(ss.reloadOffSession).not.toHaveBeenCalled();
    expect(await promoRows(orgId)).toHaveLength(0);
  });

  it("ONE call: payment page for the chosen amount, card saved off-session, prepaid + auto top-up armed", async () => {
    await mark();
    const res = await request(app)
      .post("/v1/accounts/prepaid_checkout")
      .set(getAuthHeaders(orgId, person))
      .send(checkoutBody);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      url: "https://checkout.stripe.com/pay/cs_mock",
      session_id: "cs_mock",
      payment_mode: "prepaid",
      free_credit_offer: "agent_api",
      topup_amount_cents: 1000,
      auto_topup: { amount_cents: 1500, threshold_cents: 500 },
    });
    const body = ss.createCheckoutSession.mock.calls[0][1];
    expect(body.mode).toBe("payment");
    expect(body.line_items[0].price_data.unit_amount).toBe(1000);
    expect(body.payment_intent_data.setup_future_usage).toBe("off_session");
    expect(body.discounts).toBeUndefined();

    const [account] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(account).toMatchObject({ paymentMode: "prepaid", topupAmountCents: 1500, topupThresholdCents: 500 });
  });

  it("an org with NO account calling the checkout is created as agent_api, never with the $30 advance", async () => {
    const res = await request(app)
      .post("/v1/accounts/prepaid_checkout")
      .set(getAuthHeaders(unmarkedOrgId, person))
      .send(checkoutBody);
    expect(res.status).toBe(200);
    expect(res.body.free_credit_offer).toBe("agent_api");
    expect(await promoRows(unmarkedOrgId)).toHaveLength(0);
  });

  it("after paying $10: balance is exactly $10, and falling under $5 reloads exactly $15", async () => {
    await mark();
    await request(app).post("/v1/accounts/prepaid_checkout").set(getAuthHeaders(orgId, person)).send(checkoutBody);
    ss.sumSucceededTopupsForOrg.mockResolvedValue(cents(1000));

    const account = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId, person));
    expect(account.body.credited_cents).toBe(cents(1000));
    expect(account.body.balance_cents).toBe(cents(1000));
    expect(account.body.credited_gifted_cents).toBe(cents(0));
    expect(account.body.has_auto_topup).toBe(true);

    const status = await request(app).get("/v1/accounts/prepaid_status").set(getAuthHeaders(orgId, person));
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      state: "active",
      payment_mode: "prepaid",
      paid_cents: cents(1000),
      balance_cents: cents(1000),
      auto_topup: { enabled: true, amount_cents: 1500, threshold_cents: 500 },
      card: { saved: true, reloadable: true, not_reloadable_reason: null },
    });

    // $6 spent: balance $4 < $5 → one $15 reload.
    usage.mockResolvedValue({ spent_cents: cents(600) });
    const auth = await request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId, person), "x-campaign-id": "00000000-0000-0000-0000-00000000ca01" })
      .send({ items: [{ costName: "anthropic-sonnet-4-5-tokens-input", quantity: 1000 }], description: "agent spend" });
    expect(auth.status).toBe(200);
    expect(ss.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ss.reloadOffSession.mock.calls[0][1]).toBe(1500);
  });

  it("a prepaid card is FLAGGED (card_not_reloadable), the payment is kept", async () => {
    await mark();
    await request(app).post("/v1/accounts/prepaid_checkout").set(getAuthHeaders(orgId, person)).send(checkoutBody);
    ss.sumSucceededTopupsForOrg.mockResolvedValue(cents(1000));
    ss.getSavedPaymentMethod.mockResolvedValue({
      object: "saved_payment_method",
      org_id: orgId,
      acquirer: "stripe",
      saved: true,
      method: { id: "pm_x", type: "card", saved_for: "merchant", funding: "prepaid", prepaid: true },
    });
    const status = await request(app).get("/v1/accounts/prepaid_status").set(getAuthHeaders(orgId, person));
    expect(status.body).toMatchObject({
      state: "card_not_reloadable",
      balance_cents: cents(1000),
      card: { saved: true, reloadable: false, not_reloadable_reason: "prepaid_card" },
    });
  });

  it("before paying: awaiting_payment", async () => {
    await mark();
    await request(app).post("/v1/accounts/prepaid_checkout").set(getAuthHeaders(orgId, person)).send(checkoutBody);
    ss.getSavedPaymentMethod.mockResolvedValue({
      object: "saved_payment_method",
      org_id: orgId,
      acquirer: "stripe",
      saved: false,
      method: null,
    });
    const status = await request(app).get("/v1/accounts/prepaid_status").set(getAuthHeaders(orgId, person));
    expect(status.body.state).toBe("awaiting_payment");
  });

  it("auto top-up cannot be switched off while prepaid; its amounts can change", async () => {
    await mark();
    await request(app).post("/v1/accounts/prepaid_checkout").set(getAuthHeaders(orgId, person)).send(checkoutBody);
    const off = await request(app).delete("/v1/accounts/auto_topup").set(getAuthHeaders(orgId, person));
    expect(off.status).toBe(409);
    expect(off.body.code).toBe("auto_topup_required");

    const change = await request(app)
      .patch("/v1/accounts/auto_topup")
      .set(getAuthHeaders(orgId, person))
      .send({ topup_amount_cents: 2000, topup_threshold_cents: 700 });
    expect(change.status).toBe(200);
    const [account] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(account).toMatchObject({ topupAmountCents: 2000, topupThresholdCents: 700 });
  });

  it("other orgs can still switch auto top-up off (unchanged)", async () => {
    await insertTestAccount({ orgId: unmarkedOrgId, topupAmountCents: 5000, topupThresholdCents: 0, paymentMode: "prepaid" });
    const off = await request(app).delete("/v1/accounts/auto_topup").set(getAuthHeaders(unmarkedOrgId, person));
    expect(off.status).toBe(200);
  });

  it("a subscription started later gets NO free trial: the first month is charged at start", async () => {
    await mark();
    const res = await request(app)
      .post("/v1/accounts/subscription/start")
      .set(getAuthHeaders(orgId, person))
      .send({});
    expect(res.status).toBe(200);
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.orgId, orgId));
    expect(sub.status).toBe("active");
    expect(sub.trialEndsAt).toBeNull();
    expect(ss.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(await promoRows(orgId)).toHaveLength(0);
  });

  it("an org touched BEFORE the mark keeps what it got (reported), and gets nothing more", async () => {
    // First billing touch as an ordinary new org: match_100 + $30 advance.
    await request(app).get("/v1/accounts").set(getAuthHeaders(orgId, person));
    const res = await mark();
    expect(res.body).toMatchObject({ created: false, alreadyMarked: false, freeCreditHeldCents: "3000.0000000000" });
    const [account] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(account).toMatchObject({ freeCreditOffer: "agent_api", freeCreditEntitlementCents: 0, welcomeCompletionEligible: false });
    // The $30 stays an advance, repaid by the first payment: paying $100 credits $100.
    ss.sumSucceededTopupsForOrg.mockResolvedValue(cents(10000));
    const after = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId, person));
    expect(after.body.credited_cents).toBe(cents(10000));
    expect(after.body.credited_gifted_cents).toBe(cents(0));
    expect(await promoRows(orgId)).toHaveLength(1);
  });
});
