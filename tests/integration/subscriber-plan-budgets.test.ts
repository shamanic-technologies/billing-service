/**
 * A SUBSCRIBER's campaign budgets come from its PLAN (owner 2026-10-05,
 * lib/subscriber-plan-budgets, migration 0065). Pins, on the prod reference shape
 * ($99 plan, legacy $50/day ceilings on cold email reply ON, cold email visit OFF,
 * AI meeting booking ON):
 *   - ON entry reads $99/month (the plan), AI meeting booking Max $50/month (half,
 *     rounded UP to the dollar), the OFF campaign reads "not set";
 *   - daily ceilings = monthly / 30 (campaign-service paces on the new figure);
 *   - NOTHING is charged and the plan amount never moves (sweep, status change,
 *     renewal); a prepaid org is never touched; the sweep is idempotent;
 *   - a customer restating a budget makes it theirs again (priced as before).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { campaignDailyBudgets, subscriptionCharges } from "../../src/db/schema.js";
import { advanceSubscription, listLiveSubscriptions } from "../../src/lib/subscription.js";
import { onCampaignStatusChanged } from "../../src/lib/campaign-items.js";
import { restateSubscriberBudgetsFromPlans } from "../../src/lib/subscriber-plan-budgets.js";
import {
  __primeSalesPathTerms,
  __resetSalesPathTerms,
  type PublishedSalesChannel,
} from "../../src/lib/sales-path-terms.js";

const orgId = "00000000-0000-0000-0000-0000000065a1";
const userId = "00000000-0000-0000-0000-0000000065a9";
const headers = getAuthHeaders(orgId, userId);
const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const HOUR = 60 * 60 * 1000;

const BRAND = "aaaaaaaa-0065-4000-8000-000000000001";
const OFFER = "aaaaaaaa-0065-4000-8000-0000000000a1";
const COLD = "sales-cold-email-outreach";
const REPLY = "start_to_conversation";
const VISIT = "start_to_website_visit";
const MEET = "ai-meeting-booking";
const MEET_LEG = "conversation_to_meeting_booked";

const CATALOGUE: PublishedSalesChannel[] = [
  {
    slug: COLD,
    operatedBy: "platform",
    managed: true,
    stepTransitions: [
      { legKey: REPLY, from: null, reactive: false, minimumMonthlyBudgetCents: 9900 },
      { legKey: VISIT, from: null, reactive: false, minimumMonthlyBudgetCents: 9900 },
    ],
  },
  {
    slug: MEET,
    operatedBy: "platform",
    managed: true,
    stepTransitions: [{ legKey: MEET_LEG, from: { key: "conversation" }, reactive: true, minimumMonthlyBudgetCents: 0 }],
  },
];

const REVOLUT_CARD = {
  object: "saved_payment_method",
  org_id: orgId,
  acquirer: "revolut",
  saved: true,
  method: { id: "rpm_1", type: "card", saved_for: "merchant" },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("subscriber campaign budgets from the plan", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let onCampaigns: Set<string>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    __resetSalesPathTerms();
    __primeSalesPathTerms(CATALOGUE);
    onCampaigns = new Set([`${COLD}:${REPLY}`, `${MEET}:${MEET_LEG}`]);

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
      if (url.endsWith("/orgs/brands")) return json({ brands: [{ id: BRAND, createdAt: "2026-08-01T00:00:00Z" }] });
      if (url.endsWith(`/internal/brands/${BRAND}/offers`)) return json({ offers: [{ offerId: OFFER, status: "active" }] });
      return json({ offers: [] });
    });

    const cs = await import("../../src/lib/campaign-service-client.js");
    vi.spyOn(cs, "fetchRecurringCampaignStatuses").mockImplementation(async (org: string) => ({
      ok: true,
      campaigns: [`${COLD}:${REPLY}`, `${COLD}:${VISIT}`, `${MEET}:${MEET_LEG}`].map((k, i) => {
        const [featureSlug, legKey] = k.split(":");
        return {
          campaignId: `00000000-0000-4000-8000-00000000006${i}`,
          orgId: org,
          brandId: BRAND,
          offerId: OFFER,
          legKey,
          featureSlug,
          status: onCampaigns.has(k) ? "ongoing" : "stopped",
          running: onCampaigns.has(k),
          executedByPlatform: true,
          kind: null,
          audience: "available" as const,
          allAudiencesExhausted: false,
          recurring: true,
        };
      }),
    }));

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({ org_id: orgId, spent_cents: "0.0000000000", as_of: "2026-10-01T00:00:00.000Z" });
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({ org_id: orgId, spent_cents: "0.0000000000", as_of: "2026-10-01T00:00:00.000Z" });
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue("00000000-0000-0000-0000-00000000a065");
    vi.spyOn(runsClient, "completePlatformRun").mockResolvedValue(undefined);
    const email = await import("../../src/lib/email-client.js");
    vi.spyOn(email, "sendEmail").mockImplementation(vi.fn());
  });

  afterAll(async () => {
    __resetSalesPathTerms();
    await cleanTestData();
    await closeDb();
  });

  const itemsPath = `/v1/brands/${BRAND}/offers/${OFFER}/campaign-budgets`;
  const campaignsQuery = `?campaigns=${COLD}:${REPLY},${MEET}:${MEET_LEG},${COLD}:${VISIT}`;

  function item(body: { items: Array<{ featureSlug: string; legKey: string }> }, slug: string, leg: string) {
    return body.items.find((i) => i.featureSlug === slug && i.legKey === leg) as Record<string, unknown> | undefined;
  }

  /** A subscriber with an ACTIVE $99 plan for BRAND x OFFER, holding the legacy $50/day rows. */
  async function legacySubscriber(monthly = 9900) {
    await insertTestAccount({ orgId });
    const res = await request(app)
      .post("/v1/accounts/subscriptions")
      .set(headers)
      .send({ brand_id: BRAND, offer_id: OFFER, monthly_amount_cents: monthly });
    expect(res.status).toBe(201);
    ssMocks.reloadOffSession.mockClear();
    await db.insert(campaignDailyBudgets).values(
      [
        [COLD, REPLY],
        [COLD, VISIT],
        [MEET, MEET_LEG],
      ].map(([featureSlug, legKey]) => ({
        orgId,
        brandId: BRAND,
        offerId: OFFER,
        featureSlug,
        legKey,
        dailyBudgetCents: "5000",
        updatedAt: new Date(),
      }))
    );
    const [plan] = await listLiveSubscriptions(orgId);
    return plan;
  }

  it("the reference shape: entry ON = the plan, AI meeting booking Max $50, OFF = not set; nothing charged", async () => {
    const plan = await legacySubscriber();
    let res = await request(app).get(`${itemsPath}${campaignsQuery}`).set(headers);
    expect(item(res.body, COLD, REPLY)).toMatchObject({ statedPeriod: "day", budgetCents: 150000 });

    const sweep = await restateSubscriberBudgetsFromPlans();
    expect(sweep).toMatchObject({ offers: 1, restatedOffers: 1, restatedOrgs: 1, rowsRestated: 2, rowsDeleted: 1, skipped: 0 });

    res = await request(app).get(`${itemsPath}${campaignsQuery}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("month");
    expect(item(res.body, COLD, REPLY)).toMatchObject({
      period: "month",
      statedPeriod: "month",
      budgetCents: 9900,
      dailyBudgetCents: "330.0000000000",
    });
    expect(item(res.body, MEET, MEET_LEG)).toMatchObject({
      period: "month",
      statedPeriod: "month",
      role: "reactive",
      budgetCents: 5000,
      capCents: 5000,
    });
    expect(item(res.body, COLD, VISIT)).toMatchObject({ budgetCents: null, statedPeriod: null, dailyBudgetCents: null });
    // Derived budgets never price the plan: it keeps its amount.
    expect(res.body.pricing).toBeNull();
    expect(res.body.plan).toEqual({ subscriptionId: plan.id, monthlyAmountCents: 9900 });

    // campaign-service paces on the new figures (items mode, monthly / 30).
    const sb = await request(app).get(`/internal/brands/${BRAND}/sales-budget`).set(internal);
    expect(sb.body.mode).toBe("items");
    expect(sb.body.dailyBudgetCents).toBe("496.6666666667");

    // Idempotent: a second tick finds nothing to restate.
    expect((await restateSubscriberBudgetsFromPlans()).offers).toBe(0);

    // No charge, no re-price: on a campaign status change, nor at renewal.
    await onCampaignStatusChanged({ orgId, brandId: BRAND, offerId: OFFER });
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
    expect((await listLiveSubscriptions(orgId))[0].monthlyAmountCents).toBe(9900);
    await advanceSubscription(plan, new Date(plan.currentPeriodEnd.getTime() + HOUR));
    const charges = await db.select().from(subscriptionCharges).where(eq(subscriptionCharges.subscriptionId, plan.id));
    const renewal = charges.find((c) => c.periodStart.getTime() === plan.currentPeriodEnd.getTime());
    expect(renewal).toMatchObject({ amountCents: 9900, reactiveCents: 0 });
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(9900);
  });

  it("a customer restating a budget makes it theirs: priced as before, the derived follow-up still not charged", async () => {
    await legacySubscriber();
    await restateSubscriberBudgetsFromPlans();
    const res = await request(app)
      .put(itemsPath)
      .set(headers)
      .send({ items: [{ featureSlug: COLD, legKey: REPLY, budgetCents: 19900 }] });
    expect(res.status).toBe(200);
    expect(res.body.reactiveChargedCents).toBe(0);
    expect(res.body.plan.monthlyAmountCents).toBe(19900);
    const rows = await db.select().from(campaignDailyBudgets);
    expect(rows.find((r) => r.featureSlug === COLD)?.planDerived).toBe(false);
    expect(rows.find((r) => r.featureSlug === MEET)?.planDerived).toBe(true);
    expect(item(res.body, MEET, MEET_LEG)).toMatchObject({ budgetCents: 5000, capCents: 10000 });
  });

  it("two ON entries share the plan in whole dollars; the follow-up max is half, rounded up", async () => {
    onCampaigns.add(`${COLD}:${VISIT}`);
    await legacySubscriber();
    const sweep = await restateSubscriberBudgetsFromPlans();
    expect(sweep).toMatchObject({ rowsRestated: 3, rowsDeleted: 0 });
    const res = await request(app).get(itemsPath).set(headers);
    // $99 over two: the leftover dollar goes to the first (by channel, then leg).
    expect(item(res.body, COLD, REPLY)).toMatchObject({ budgetCents: 5000 });
    expect(item(res.body, COLD, VISIT)).toMatchObject({ budgetCents: 4900 });
    expect(item(res.body, MEET, MEET_LEG)).toMatchObject({ budgetCents: 5000, capCents: 5000 });
  });

  it("no ON entry campaign: left as is; a prepaid org is never touched", async () => {
    onCampaigns.clear();
    await legacySubscriber();
    const sweep = await restateSubscriberBudgetsFromPlans();
    expect(sweep).toMatchObject({ offers: 1, restatedOffers: 0, skipped: 1 });
    expect((await db.select().from(campaignDailyBudgets)).every((r) => r.monthlyBudgetCents === null)).toBe(true);

    await cleanTestData();
    await insertTestAccount({ orgId, paymentMode: "prepaid" });
    await db.insert(campaignDailyBudgets).values({
      orgId,
      brandId: BRAND,
      offerId: OFFER,
      featureSlug: COLD,
      legKey: REPLY,
      dailyBudgetCents: "5000",
      updatedAt: new Date(),
    });
    expect((await restateSubscriberBudgetsFromPlans()).offers).toBe(0);
    const [row] = await db.select().from(campaignDailyBudgets);
    expect(row).toMatchObject({ dailyBudgetCents: "5000.0000000000", monthlyBudgetCents: null, planDerived: false });
  });
});
