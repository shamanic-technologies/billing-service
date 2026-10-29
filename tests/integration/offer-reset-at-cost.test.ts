/**
 * OFFER-RESET-1029 (owner 2026-10-29): every account created from now on is on the
 * at-cost offer. « on arrete le $100 de free credit et les $ gratuits de referral.
 * Bien sur on grandfather les clients actuels. »
 *
 * Worked example: a new org gets a $5 onboarding ADVANCE, pays a first $10 top-up on
 * the checkout page with an automatic reload of $15 below $5. No $100 match, no
 * referral reward, no postpaid. Its no-campaign spend (onboarding, chat, card fees)
 * is billed to it. An account created before keeps its own offer.
 *
 * Own file: other suites close the shared connection in `afterAll` (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import * as runsClient from "../../src/lib/runs-client.js";
import { db } from "../../src/db/index.js";
import {
  billingAccounts,
  freeCreditPromises,
  localPromoCodes,
  localPromos,
  ORG_CREATION_BONUS_CODE,
} from "../../src/db/schema.js";

const orgId = "00000000-0000-0000-0000-0000000009a1";
const legacyOrgId = "00000000-0000-0000-0000-0000000009a2";
const matchOrgId = "00000000-0000-0000-0000-0000000009a3";
const refereeOrgId = "00000000-0000-0000-0000-0000000009a4";
const person = "11111111-1111-4111-8111-1111111119a1";
const internal = { "X-API-Key": "test-api-key" };
const cents = (n: number) => `${n}.0000000000`;

const checkoutBody = {
  topup_amount_cents: 1000,
  auto_topup_amount_cents: 1500,
  auto_topup_threshold_cents: 500,
  success_url: "https://distribute.you/ok",
  cancel_url: "https://distribute.you/cancel",
};

async function rowsByCode(id: string, code: string) {
  return db
    .select({ amountCents: localPromos.amountCents, description: localPromos.description })
    .from(localPromos)
    .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
    .where(and(eq(localPromos.orgId, id), eq(localPromoCodes.code, code)));
}

describe("At-cost offer for every new account (OFFER-RESET-1029)", () => {
  const app = createTestApp();
  let ss: ReturnType<typeof setupStripeMocks>;
  let usage: ReturnType<typeof vi.fn>;
  let noCampaign: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ss = setupStripeMocks();
    await cleanTestData();
    usage = vi.fn().mockResolvedValue({ spent_cents: cents(0) });
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(usage as never);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(usage as never);
    noCampaign = vi
      .spyOn(runsClient, "fetchRunsOrgNoCampaignTotal")
      .mockResolvedValue({ usageNetCents: cents(0), actualNetCents: cents(0) });
    ss.sumSucceededTopupsForOrg.mockResolvedValue(cents(0));
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  const account = (id: string) => request(app).get("/v1/accounts").set(getAuthHeaders(id, person));

  it("a brand-new org: prepaid, a $5 ADVANCE (not a gift), no match to come", async () => {
    const res = await account(orgId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      free_credit_offer: "prepaid_at_cost",
      payment_mode: "prepaid",
      credited_cents: cents(500),
      credited_advance_cents: cents(500),
      credited_gifted_cents: cents(0),
      credited_paid_cents: cents(0),
      free_credit_entitlement_cents: 0,
      free_credit_pending_cents: cents(0),
    });
    const bonus = await rowsByCode(orgId, ORG_CREATION_BONUS_CODE);
    expect(bonus).toHaveLength(1);
    expect(bonus[0].amountCents).toBe(cents(500));
    expect(bonus[0].description).toBe("Onboarding credit advance: $5.00");
  });

  it("trial seed, creation-bonus call and signup all land the SAME single $5, never more", async () => {
    const seed = await request(app).post(`/internal/accounts/by-org/${orgId}/trial-seed`).set(internal);
    expect(seed.status).toBe(200);
    expect(seed.body.seededCents).toBe(500);
    const bonus = await request(app).post(`/internal/accounts/by-org/${orgId}/org-creation-bonus`).set(internal);
    expect(bonus.body).toMatchObject({ grantedCents: 500, alreadyGranted: true });
    const signup = await request(app)
      .post(`/internal/accounts/by-org/${orgId}/signup`)
      .set({ ...internal, "x-user-id": person });
    expect(signup.status).toBe(200);
    expect(signup.body.welcomeGrantedCents).toBe(0);
    const res = await account(orgId);
    expect(res.body.credited_cents).toBe(cents(500));
    expect(await rowsByCode(orgId, ORG_CREATION_BONUS_CODE)).toHaveLength(1);
  });

  it("the first $10 payment repays the $5 advance: credited $10, never $15, and no match at any amount", async () => {
    await account(orgId);
    ss.sumSucceededTopupsForOrg.mockResolvedValue(cents(1000));
    let res = await account(orgId);
    expect(res.body.credited_cents).toBe(cents(1000));
    expect(res.body.credited_paid_cents).toBe(cents(500));
    ss.sumSucceededTopupsForOrg.mockResolvedValue(cents(50000));
    res = await account(orgId);
    expect(res.body.credited_cents).toBe(cents(50000));
    expect(res.body.credited_gifted_cents).toBe(cents(0));
  });

  it("no free money: welcome, invite and product-task grants are refused", async () => {
    await account(orgId);
    const redeem = await request(app)
      .post("/v1/promotion_codes/redeem")
      .set(getAuthHeaders(orgId, person))
      .send({ code: "welcome" });
    expect(redeem.status).toBe(409);
    const invite = await request(app)
      .post("/internal/credits/grant")
      .set(internal)
      .send({ orgId, amountCents: 2500, reason: "invite_welcome" });
    expect(invite.status).toBe(409);
    expect(invite.body.code).toBe("free_credit_not_offered");
    const task = await request(app)
      .post("/internal/credits/grant")
      .set(internal)
      .send({ orgId, amountCents: 200, reason: "product_task_completed", completionId: "task-1" });
    expect(task.status).toBe(409);
    expect(await rowsByCode(orgId, ORG_CREATION_BONUS_CODE)).toHaveLength(1);
    const all = await db.select().from(localPromos).where(eq(localPromos.orgId, orgId));
    expect(all).toHaveLength(1);
  });

  it("postpaid is not offered to the customer", async () => {
    await account(orgId);
    ss.hasAttachedCardPm.mockResolvedValue(true);
    const res = await request(app)
      .put("/v1/accounts/payment_mode")
      .set(getAuthHeaders(orgId, person))
      .send({ payment_mode: "postpaid" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("postpaid_not_offered");
    const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(row.paymentMode).toBe("prepaid");
  });

  it("the dashboard checkout takes the first top-up AND the reload settings in one step; the reload is optional (off, then on again)", async () => {
    await account(orgId);
    const res = await request(app)
      .post("/v1/accounts/prepaid_checkout")
      .set(getAuthHeaders(orgId, person))
      .send(checkoutBody);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      payment_mode: "prepaid",
      free_credit_offer: "prepaid_at_cost",
      topup_amount_cents: 1000,
      auto_topup: { amount_cents: 1500, threshold_cents: 500 },
    });
    expect(ss.createCheckoutSession.mock.calls[0][1].line_items[0].price_data.unit_amount).toBe(1000);
    const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(row).toMatchObject({ topupAmountCents: 1500, topupThresholdCents: 500 });

    // Owner 2026-10-29: « Top up should be optional, but checked by default ».
    const off = await request(app).delete("/v1/accounts/auto_topup").set(getAuthHeaders(orgId, person));
    expect(off.status).toBe(200);
    const [disarmed] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(disarmed).toMatchObject({ topupAmountCents: null, topupThresholdCents: null, paymentMode: "prepaid" });

    const on = await request(app)
      .patch("/v1/accounts/auto_topup")
      .set(getAuthHeaders(orgId, person))
      .send({ topup_amount_cents: 1500, topup_threshold_cents: 500 });
    expect(on.status).toBe(200);
    const [rearmed] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(rearmed).toMatchObject({ topupAmountCents: 1500, topupThresholdCents: 500, paymentMode: "prepaid" });
  });

  it("its no-campaign spend (onboarding, chat, card fees) lowers ITS balance; an older org's is still absorbed", async () => {
    await account(orgId);
    await insertTestAccount({ orgId: legacyOrgId });
    ss.sumSucceededTopupsForOrg.mockResolvedValue(cents(1000));
    usage.mockResolvedValue({ spent_cents: cents(140) });
    noCampaign.mockResolvedValue({ usageNetCents: cents(40), actualNetCents: cents(40) });

    const atCost = await request(app).get(`/internal/accounts/by-org/${orgId}/balance`).set(internal);
    expect(atCost.body.balance_cents).toBe(cents(860));
    const legacy = await request(app).get(`/internal/accounts/by-org/${legacyOrgId}/balance`).set(internal);
    expect(legacy.body.balance_cents).toBe(cents(900));
  });

  it("a referrer created under the at-cost offer earns NO referral reward; an existing referrer still does", async () => {
    await account(orgId);
    const none = await request(app)
      .post("/internal/referrals/claim")
      .set(internal)
      .send({ orgId: refereeOrgId, referrerOrgId: orgId });
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ ok: true, rewardOffered: false, promise: null });
    expect(
      await db.select().from(freeCreditPromises).where(eq(freeCreditPromises.referredOrgId, refereeOrgId))
    ).toHaveLength(0);

    await insertTestAccount({ orgId: legacyOrgId });
    const kept = await request(app)
      .post("/internal/referrals/claim")
      .set(internal)
      .send({ orgId: refereeOrgId, referrerOrgId: legacyOrgId });
    expect(kept.status).toBe(200);
    expect(kept.body.rewardOffered).toBe(true);
    expect(kept.body.promise.orgId).toBe(legacyOrgId);
  });

  it("accounts created before keep their offer, figures and payment mode", async () => {
    await insertTestAccount({
      orgId: matchOrgId,
      freeCreditOffer: "match_100",
      freeCreditEntitlementCents: 10000,
      freeCreditPaidTriggerCents: 10000,
      paymentMode: "postpaid",
    });
    await insertTestAccount({ orgId: legacyOrgId, paymentMode: "prepaid" });
    const match = await account(matchOrgId);
    expect(match.body).toMatchObject({
      free_credit_offer: "match_100",
      payment_mode: "postpaid",
      free_credit_entitlement_cents: 10000,
    });
    const legacy = await account(legacyOrgId);
    expect(legacy.body).toMatchObject({ free_credit_offer: "legacy", payment_mode: "prepaid" });
  });
});
