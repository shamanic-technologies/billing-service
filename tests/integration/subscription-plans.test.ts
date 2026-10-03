/**
 * PLANS PER BRAND x OFFER (owner decision 2026-10-03; lib/subscription +
 * lib/subscription-plans). Pins:
 *   - an org already on the onboarding plan reads it back unchanged through the
 *     org-level routes, and the list attributes it to the org's FIRST brand x offer;
 *   - a plan bought for a second brand x offer has NO trial: the card is charged at
 *     once, the list then shows two live plans;
 *   - the same brand x offer twice, no card, a declined card, an outage and an
 *     offer the org does not sell are each refused with a named code;
 *   - revenue sums every paying plan; the charge schedule carries every plan;
 *   - with several plans, a plan's boundary never expires more than its own month.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { subscriptionCreditExpiries, subscriptions } from "../../src/db/schema.js";
import {
  advanceSubscription,
  listLiveSubscriptions,
  startSubscription,
} from "../../src/lib/subscription.js";
import { getOrgRevenue } from "../../src/lib/revenue.js";
import { getChargeSchedule } from "../../src/lib/charge-schedule.js";

const orgId = "00000000-0000-0000-0000-0000000006b1";
const userId = "00000000-0000-0000-0000-0000000006b9";
const headers = getAuthHeaders(orgId, userId);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const BRAND_A = "aaaaaaaa-0000-4000-8000-000000000001";
const OFFER_A1 = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BRAND_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OFFER_B1 = "bbbbbbbb-0000-4000-8000-0000000000b1";
const OFFER_B2 = "bbbbbbbb-0000-4000-8000-0000000000b2";
const OFFER_ARCHIVED = "bbbbbbbb-0000-4000-8000-0000000000b9";

const REVOLUT_CARD = {
  object: "saved_payment_method",
  org_id: orgId,
  acquirer: "revolut",
  saved: true,
  method: { id: "rpm_1", type: "card", saved_for: "merchant" },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("plans per brand x offer", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let setUsage: (cents: string) => void;
  let brandServiceDown = false;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    brandServiceDown = false;

    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@new.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");
    ssMocks.getSavedPaymentMethod.mockResolvedValue(REVOLUT_CARD);

    process.env.BRAND_SERVICE_URL = "http://brand.test";
    process.env.BRAND_SERVICE_API_KEY = "brand-key";
    const fetchRetry = await import("../../src/lib/fetch-retry.js");
    vi.spyOn(fetchRetry, "fetchWithRetry").mockImplementation(async (url: string) => {
      if (!url.startsWith("http://brand.test")) throw new Error(`unexpected fetch ${url}`);
      if (brandServiceDown) return json({ error: "down" }, 503);
      if (url.endsWith("/orgs/brands")) {
        // Listed newest first, as brand-service does: the FIRST brand is A (oldest).
        return json({
          brands: [
            { id: BRAND_B, createdAt: "2026-09-01T00:00:00Z" },
            { id: BRAND_A, createdAt: "2026-08-01T00:00:00Z" },
          ],
        });
      }
      if (url.endsWith(`/internal/brands/${BRAND_A}/offers`)) {
        return json({ offers: [{ offerId: OFFER_A1, status: "active" }] });
      }
      if (url.endsWith(`/internal/brands/${BRAND_B}/offers`)) {
        return json({
          offers: [
            { offerId: OFFER_ARCHIVED, status: "archived" },
            { offerId: OFFER_B1, status: "active" },
            { offerId: OFFER_B2, status: "active" },
          ],
        });
      }
      return json({ offers: [] });
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
    const email = await import("../../src/lib/email-client.js");
    vi.spyOn(email, "sendEmail").mockImplementation(vi.fn());
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  /** The org on the onboarding plan: 3-day trial, no brand / offer recorded. */
  async function onboardingPlan(amount = 9900, now = new Date()) {
    await insertTestAccount({ orgId });
    return startSubscription({ orgId, userId, monthlyAmountCents: amount, now });
  }

  function buy(brandId: string, offerId: string, amount = 9900) {
    return request(app)
      .post("/v1/accounts/subscriptions")
      .set(headers)
      .send({ brand_id: brandId, offer_id: offerId, monthly_amount_cents: amount });
  }

  it("the onboarding plan reads back unchanged, and the list ties it to the FIRST brand x offer", async () => {
    await onboardingPlan();
    const legacy = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(legacy.status).toBe(200);
    expect(legacy.body.payment_mode).toBe("subscription");
    expect(legacy.body.trial_grant_cents).toBe(9900);
    expect(legacy.body.subscription).toMatchObject({ status: "trialing", monthly_amount_cents: 9900 });

    const list = await request(app).get("/v1/accounts/subscriptions").set(headers);
    expect(list.status).toBe(200);
    expect(list.body.subscriptions).toHaveLength(1);
    expect(list.body.subscriptions[0]).toMatchObject({
      id: legacy.body.subscription.id,
      brand_id: BRAND_A,
      offer_id: OFFER_A1,
      status: "trialing",
      monthly_amount_cents: 9900,
    });
    expect(list.body.credits_remaining_cents).toBe("9900.0000000000");
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("a second brand x offer: no trial, charged at once, two live plans", async () => {
    await onboardingPlan();
    const res = await buy(BRAND_B, OFFER_B1, 19900);
    expect(res.status).toBe(201);
    expect(res.body.subscription).toMatchObject({
      brand_id: BRAND_B,
      offer_id: OFFER_B1,
      status: "active",
      trial_end: null,
      monthly_amount_cents: 19900,
    });
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadOffSession.mock.calls[0][0]).toBe(orgId);
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(19900);

    const list = await request(app).get("/v1/accounts/subscriptions").set(headers);
    expect(list.body.subscriptions.map((s: { brand_id: string; offer_id: string; status: string }) => [s.brand_id, s.offer_id, s.status])).toEqual([
      [BRAND_A, OFFER_A1, "trialing"],
      [BRAND_B, OFFER_B1, "active"],
    ]);

    // The org-level route still reads the onboarding (primary) plan.
    const legacy = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(legacy.body.subscription).toMatchObject({ status: "trialing", monthly_amount_cents: 9900 });
  });

  it("the same brand x offer twice is refused: plan_exists_for_offer (the onboarding pair too)", async () => {
    await onboardingPlan();
    expect((await buy(BRAND_B, OFFER_B2)).status).toBe(201);
    let res = await buy(BRAND_B, OFFER_B2);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("plan_exists_for_offer");
    // The onboarding plan is attributed before the check, so its pair is taken too.
    res = await buy(BRAND_A, OFFER_A1);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("plan_exists_for_offer");
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
  });

  it("no card on file is refused: card_required, nothing charged", async () => {
    await onboardingPlan();
    ssMocks.authorizeRecurringCharges.mockResolvedValue({ authorized: false, reason: "no_card" });
    const res = await buy(BRAND_B, OFFER_B1);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("card_required");
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
    expect(await listLiveSubscriptions(orgId)).toHaveLength(1);
  });

  it("a declined card is refused: first_charge_declined, no plan left live, retryable", async () => {
    await onboardingPlan();
    ssMocks.reloadOffSession.mockResolvedValueOnce({ status: "failed", failure_code: "insufficient_funds" });
    let res = await buy(BRAND_B, OFFER_B1);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("first_charge_declined");
    expect(await listLiveSubscriptions(orgId)).toHaveLength(1);
    res = await buy(BRAND_B, OFFER_B1);
    expect(res.status).toBe(201);
  });

  it("a charge that could not be attempted is charge_unavailable (502), nothing starts", async () => {
    await onboardingPlan();
    ssMocks.reloadOffSession.mockRejectedValueOnce(new Error("stripe-service POST /x failed: 503 down"));
    const res = await buy(BRAND_B, OFFER_B1);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("charge_unavailable");
    expect(await listLiveSubscriptions(orgId)).toHaveLength(1);
  });

  it("an offer the org does not sell (or archived) is offer_not_found; bad body / amount is 400", async () => {
    await onboardingPlan();
    let res = await buy(BRAND_B, OFFER_ARCHIVED);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("offer_not_found");
    res = await buy(BRAND_A, OFFER_B1);
    expect(res.status).toBe(404);
    res = await buy(BRAND_B, OFFER_B1, 2800);
    expect(res.status).toBe(400);
    res = await request(app).post("/v1/accounts/subscriptions").set(headers).send({ brand_id: BRAND_B });
    expect(res.status).toBe(400);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("brand-service unreachable: the start and the list fail loud (502), nothing charged", async () => {
    await onboardingPlan();
    brandServiceDown = true;
    expect((await buy(BRAND_B, OFFER_B1)).status).toBe(502);
    expect((await request(app).get("/v1/accounts/subscriptions").set(headers)).status).toBe(502);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("an org with no plan yet buys its first one from the dashboard: no trial, subscription mode", async () => {
    await insertTestAccount({ orgId });
    const res = await buy(BRAND_B, OFFER_B1);
    expect(res.status).toBe(201);
    expect(res.body.subscription.status).toBe("active");
    const list = await request(app).get("/v1/accounts/subscriptions").set(headers);
    expect(list.body.payment_mode).toBe("subscription");
    expect(list.body.subscriptions).toHaveLength(1);
  });

  it("an org already paying prepaid/postpaid with no plan is refused: existing_paying_org", async () => {
    await insertTestAccount({ orgId });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("5000.0000000000");
    const res = await buy(BRAND_B, OFFER_B1);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("existing_paying_org");
  });

  it("per-plan cancel / resume / amount change act on that plan only", async () => {
    await onboardingPlan();
    const second = (await buy(BRAND_B, OFFER_B1)).body.subscription;
    let res = await request(app).post(`/v1/accounts/subscriptions/${second.id}/cancel`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.subscription).toMatchObject({ id: second.id, cancel_at_period_end: true });
    const legacy = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(legacy.body.subscription.cancel_at_period_end).toBe(false);

    res = await request(app).post(`/v1/accounts/subscriptions/${second.id}/resume`).set(headers);
    expect(res.body.subscription.cancel_at_period_end).toBe(false);
    res = await request(app)
      .patch(`/v1/accounts/subscriptions/${second.id}`)
      .set(headers)
      .send({ monthly_amount_cents: 29900 });
    expect(res.status).toBe(200);
    expect(res.body.subscription).toMatchObject({ id: second.id, monthly_amount_cents: 29900 });

    res = await request(app)
      .post("/v1/accounts/subscriptions/00000000-0000-4000-8000-00000000dead/cancel")
      .set(headers);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("no_subscription");
  });

  it("revenue: MRR is the sum of the paying plans; the trial is shown apart; cash carries every plan", async () => {
    await onboardingPlan(9900);
    await buy(BRAND_B, OFFER_B1, 19900);
    await buy(BRAND_B, OFFER_B2, 29900);
    const rev = (await getOrgRevenue(orgId))!;
    expect(rev.revenueClass).toBe("recurring");
    expect(rev.mrrCents).toBe("49800.0000000000"); // 19900 + 29900; the trialing plan is not revenue yet
    expect(rev.subscriptions).toHaveLength(3);
    expect(rev.subscription!.status).toBe("trialing");

    const schedule = (await getChargeSchedule(orgId, 40))!;
    const amounts = schedule.events.map((e) => e.expectedAmountCents);
    expect(amounts).toContain("9900");
    expect(amounts).toContain("19900");
    expect(amounts).toContain("29900");
    const ats = schedule.events.map((e) => e.at);
    expect([...ats].sort()).toEqual(ats);
  });

  it("several plans share one balance: a plan's boundary expires at most its own month", async () => {
    const t0 = new Date(Date.now() - 40 * DAY);
    await insertTestAccount({ orgId });
    // Plan B1 bought 40 days ago ($99), plan B2 5 days ago ($199): nothing spent.
    const first = await (await import("../../src/lib/subscription.js")).startPlanForOffer({
      orgId,
      userId,
      brandId: BRAND_B,
      offerId: OFFER_B1,
      monthlyAmountCents: 9900,
      now: t0,
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("9900.0000000000");
    // B1 renewed once (day 30) — model it by advancing to just before day 40.
    const renewed = await advanceSubscription(first, new Date(t0.getTime() + 31 * DAY));
    expect(renewed.status).toBe("active");
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("19800.0000000000");
    await (await import("../../src/lib/subscription.js")).startPlanForOffer({
      orgId,
      userId,
      brandId: BRAND_B,
      offerId: OFFER_B2,
      monthlyAmountCents: 19900,
      now: new Date(Date.now() - 5 * DAY),
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("39700.0000000000");
    setUsage("0.0000000000");

    // B1's next boundary (day ~60): $397 unspent in the pool, but B1 brought $99.
    const live = (await listLiveSubscriptions(orgId)).find((s) => s.offerId === OFFER_B1)!;
    await advanceSubscription(live, new Date(live.currentPeriodEnd.getTime() + HOUR));
    const rows = await db
      .select()
      .from(subscriptionCreditExpiries)
      .where(eq(subscriptionCreditExpiries.subscriptionId, live.id));
    const atBoundary = rows.find((r) => r.boundaryAt.getTime() === live.currentPeriodEnd.getTime())!;
    expect(atBoundary.amountCents).toBe("9900.0000000000");
  });

  it("one live plan per brand x offer is enforced by the database", async () => {
    await insertTestAccount({ orgId });
    expect((await buy(BRAND_B, OFFER_B1)).status).toBe(201);
    const now = new Date();
    await expect(
      db.insert(subscriptions).values({
        orgId,
        brandId: BRAND_B,
        offerId: OFFER_B1,
        status: "active",
        monthlyAmountCents: 9900,
        currentPeriodStart: now,
        currentPeriodEnd: now,
      })
    ).rejects.toThrow();
  });
});
