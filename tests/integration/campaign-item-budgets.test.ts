/**
 * ITEM BUDGETS PER CAMPAIGN (owner 2026-10-04, lib/campaign-items). Pins:
 *   - a daily (prepaid / postpaid) budget clears its published minimum over 30 days;
 *     a reactive MAX is at most 50% of the offer's entry budgets; customer-team legs
 *     and a reactive with no entry are refused, each with a legible code;
 *   - a campaign not set reads as budgetCents null; DELETE puts it back;
 *   - campaign-service reads mode "items" on the sales-budget read; a brand with no
 *     item reads exactly as before;
 *   - subscriber: the plan becomes the SUM of its ON budgets (min $99), an ON
 *     reactive part is charged NOW (once), OFF budgets are kept and not charged,
 *     a refused card writes nothing, a campaign turned ON charges its follow-up;
 *   - a channel we do not run is recorded and charged nothing, then enters the plan
 *     at the first renewal after it launches;
 *   - unspent reactive credit carries over at the boundary instead of expiring.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import {
  campaignDailyBudgets,
  salesPathReactiveCharges,
  subscriptionCharges,
  subscriptionCreditExpiries,
} from "../../src/db/schema.js";
import { advanceSubscription, listLiveSubscriptions } from "../../src/lib/subscription.js";
import { onCampaignStatusChanged } from "../../src/lib/campaign-items.js";
import {
  __primeSalesPathTerms,
  __resetSalesPathTerms,
  type PublishedSalesChannel,
} from "../../src/lib/sales-path-terms.js";

const orgId = "00000000-0000-0000-0000-0000000062a1";
const userId = "00000000-0000-0000-0000-0000000062a9";
const headers = getAuthHeaders(orgId, userId);
const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const HOUR = 60 * 60 * 1000;

const BRAND = "aaaaaaaa-0062-4000-8000-000000000001";
const OFFER = "aaaaaaaa-0062-4000-8000-0000000000a1";
const COLD = "sales-cold-email-outreach";
const REPLY = "start_to_conversation";
const VISIT = "start_to_website_visit";
const MEET = "ai-meeting-booking";
const MEET_LEG = "conversation_to_meeting_booked";
const META = "meta-ads";
const TEAM = "your-team-meeting-booking";

function catalogue(metaManaged = false): PublishedSalesChannel[] {
  return [
    {
      slug: COLD,
      operatedBy: "platform",
      managed: true,
      stepTransitions: [
        { legKey: REPLY, from: null, minimumMonthlyBudgetCents: 9900 },
        { legKey: VISIT, from: null, minimumMonthlyBudgetCents: 9900 },
      ],
    },
    {
      slug: MEET,
      operatedBy: "platform",
      managed: true,
      stepTransitions: [{ legKey: MEET_LEG, from: { key: "conversation" }, minimumMonthlyBudgetCents: 3000 }],
    },
    {
      slug: META,
      operatedBy: "platform",
      managed: metaManaged,
      stepTransitions: [{ legKey: VISIT, from: null, minimumMonthlyBudgetCents: 150000 }],
    },
    {
      slug: TEAM,
      operatedBy: "customer",
      managed: true,
      stepTransitions: [{ legKey: MEET_LEG, from: { key: "conversation" }, minimumMonthlyBudgetCents: 0 }],
    },
  ];
}

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


describe("item budgets per campaign", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let setUsage: (cents: string) => void;
  /** Campaigns that are ON (campaign-service status ongoing), as `featureSlug:legKey`. */
  let onCampaigns: Set<string>;
  let campaignStatusDown: boolean;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    __resetSalesPathTerms();
    __primeSalesPathTerms(catalogue());
    onCampaigns = new Set([`${COLD}:${REPLY}`, `${COLD}:${VISIT}`, `${MEET}:${MEET_LEG}`, `${META}:${VISIT}`]);
    campaignStatusDown = false;

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
      if (url.endsWith(`/internal/brands/${BRAND}/offers`)) {
        return json({ offers: [{ offerId: OFFER, status: "active" }] });
      }
      return json({ offers: [] });
    });

    const cs = await import("../../src/lib/campaign-service-client.js");
    vi.spyOn(cs, "fetchRecurringCampaignStatuses").mockImplementation(async () => {
      if (campaignStatusDown) return { ok: false, reason: "campaign_service_unavailable" };
      return {
        ok: true,
        campaigns: [...onCampaigns].map((k, i) => {
          const [featureSlug, legKey] = k.split(":");
          return {
            campaignId: `00000000-0000-4000-8000-00000000000${i}`,
            orgId,
            brandId: BRAND,
            offerId: OFFER,
            legKey,
            featureSlug,
            status: "ongoing",
            running: true,
            executedByPlatform: true,
            kind: null,
            audience: "available" as const,
            allAudiencesExhausted: false,
            recurring: true,
          };
        }),
      };
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
    const email = await import("../../src/lib/email-client.js");
    vi.spyOn(email, "sendEmail").mockImplementation(vi.fn());
  });

  afterAll(async () => {
    __resetSalesPathTerms();
    await cleanTestData();
    await closeDb();
  });

  const itemsPath = `/v1/brands/${BRAND}/offers/${OFFER}/campaign-budgets`;

  function put(items: Array<[string, string, number]>) {
    return request(app)
      .put(itemsPath)
      .set(headers)
      .send({ items: items.map(([featureSlug, legKey, budgetCents]) => ({ featureSlug, legKey, budgetCents })) });
  }

  function item(body: { items: Array<{ featureSlug: string; legKey: string }> }, slug: string, leg: string) {
    return body.items.find((i) => i.featureSlug === slug && i.legKey === leg);
  }

  async function salesBudget() {
    const res = await request(app).get(`/internal/brands/${BRAND}/sales-budget`).set(internal);
    expect(res.status).toBe(200);
    return res.body;
  }

  /** A subscriber holding an ACTIVE plan for BRAND x OFFER at $99 (charged once). */
  async function subscriber() {
    await insertTestAccount({ orgId });
    const res = await request(app)
      .post("/v1/accounts/subscriptions")
      .set(headers)
      .send({ brand_id: BRAND, offer_id: OFFER, monthly_amount_cents: 9900 });
    expect(res.status).toBe(201);
    ssMocks.reloadOffSession.mockClear();
    const [plan] = await listLiveSubscriptions(orgId);
    return plan;
  }

  // --- daily (prepaid / postpaid) ---------------------------------------------

  it("a brand with no budget reads exactly as before (campaigns mode, no items field)", async () => {
    await insertTestAccount({ orgId });
    const body = await salesBudget();
    expect(body).toEqual({ brandId: BRAND, orgId, mode: "campaigns", dailyBudgetCents: null, updatedAt: null });
  });

  it("not set reads as null; minimum over 30 days; customer leg and reactive-without-entry refused", async () => {
    await insertTestAccount({ orgId });
    let res = await request(app)
      .get(`${itemsPath}?campaigns=${COLD}:${REPLY},${MEET}:${MEET_LEG},${TEAM}:${MEET_LEG}`)
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("day");
    expect(item(res.body, COLD, REPLY)).toMatchObject({ budgetCents: null, role: "proactive", minimumCents: 330, managed: true, budgetable: true });
    expect(item(res.body, MEET, MEET_LEG)).toMatchObject({ budgetCents: null, role: "reactive", capCents: 0 });
    expect(item(res.body, TEAM, MEET_LEG)).toMatchObject({ budgetCents: null, role: null, budgetable: false });

    res = await put([[COLD, REPLY, 329]]);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "below_minimum", minimumCents: 330, period: "day", featureSlug: COLD });

    res = await put([[TEAM, MEET_LEG, 100]]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("customer_leg_has_no_budget");

    res = await put([[MEET, MEET_LEG, 100]]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("entry_item_required");

    res = await put([[COLD, "no_such_leg", 1000]]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("unknown_item");
    expect(await db.select().from(campaignDailyBudgets)).toHaveLength(0);
  });

  it("reactive MAX is capped at half the SUM of the offer's entry budgets; two entries coexist", async () => {
    await insertTestAccount({ orgId });
    expect((await put([[COLD, REPLY, 1000]])).status).toBe(200);
    let res = await put([[MEET, MEET_LEG, 501]]);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "reactive_above_cap", capCents: 500, featureSlug: MEET });

    // A second entry campaign on the same offer raises the cap.
    res = await put([[COLD, VISIT, 400], [MEET, MEET_LEG, 700]]);
    expect(res.status).toBe(200);
    expect(item(res.body, MEET, MEET_LEG)).toMatchObject({ budgetCents: 700, capCents: 700 });
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();

    // Removing an entry that would leave the follow-up over its cap is refused.
    res = await request(app).delete(`${itemsPath}?featureSlug=${COLD}&legKey=${VISIT}`).set(headers);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("reactive_above_cap");

    // ONE store: a daily budget IS the campaign's ceiling row, read by every existing
    // reader exactly as a ceiling (campaigns mode), never a second figure.
    const body = await salesBudget();
    expect(body.mode).toBe("campaigns");
    const one = await request(app)
      .get(`/internal/brands/${BRAND}/campaign-budget?offerId=${OFFER}&legKey=${REPLY}&featureSlug=${COLD}`)
      .set(internal);
    expect(one.body.dailyBudgetCents).toBe("1000.0000000000");
    const total = await request(app).get(`/internal/brands/${BRAND}/daily-budget`).set(internal);
    expect(total.body.dailyBudgetCents).toBe("2100.0000000000");

    // Lower the follow-up, then the entry can go; DELETE is idempotent.
    expect((await put([[MEET, MEET_LEG, 500]])).status).toBe(200);
    res = await request(app).delete(`${itemsPath}?featureSlug=${COLD}&legKey=${VISIT}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
    res = await request(app).delete(`${itemsPath}?featureSlug=${COLD}&legKey=${VISIT}`).set(headers);
    expect(res.body.removed).toBe(false);
  });

  it("one row per campaign: the old ceiling route and the new one write the same row", async () => {
    await insertTestAccount({ orgId });
    const old = await request(app)
      .put(`/v1/brands/${BRAND}/campaign-budget`)
      .set(headers)
      .send({ offerId: OFFER, legKey: REPLY, featureSlug: COLD, dailyBudgetCents: 800 });
    expect(old.status).toBe(200);
    let res = await request(app).get(itemsPath).set(headers);
    expect(res.body.items).toHaveLength(1);
    expect(item(res.body, COLD, REPLY)).toMatchObject({ budgetCents: 800, period: "day" });

    res = await put([[COLD, REPLY, 1200]]);
    expect(res.status).toBe(200);
    const rows = await db.select().from(campaignDailyBudgets);
    expect(rows).toHaveLength(1);
    expect(rows[0].dailyBudgetCents).toBe("1200.0000000000");
  });

  it("a write takes the brand out of its global sales budget", async () => {
    await insertTestAccount({ orgId });
    expect((await request(app).put(`/v1/brands/${BRAND}/sales-budget`).set(headers).send({ dailyBudgetCents: 5000 })).status).toBe(200);
    expect((await salesBudget()).mode).toBe("global");
    const res = await put([[COLD, REPLY, 1000]]);
    expect(res.status).toBe(200);
    expect(res.body.globalBudgetCleared).toBe(true);
    expect((await salesBudget()).mode).toBe("campaigns");
  });

  it("an unreadable catalogue refuses the write (502 minimums_unavailable), nothing stored", async () => {
    await insertTestAccount({ orgId });
    __resetSalesPathTerms();
    process.env.FEATURES_SERVICE_URL = "http://features.test";
    const res = await put([[COLD, REPLY, 1000]]);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("minimums_unavailable");
    expect(await db.select().from(campaignDailyBudgets)).toHaveLength(0);
  });

  // --- subscriber -------------------------------------------------------------

  it("subscriber: the plan becomes the SUM of its ON budgets; an ON reactive part is charged NOW, once", async () => {
    const plan = await subscriber();

    let res = await put([[COLD, REPLY, 20050]]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("amount_not_whole_dollars");

    res = await put([[COLD, REPLY, 20000], [MEET, MEET_LEG, 10000]]);
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("month");
    expect(res.body.reactiveChargedCents).toBe(10000);
    expect(res.body.pricing).toMatchObject({ monthlyAmountCents: 30000, reactiveMonthlyCents: 10000, deferredMonthlyCents: 0, offMonthlyCents: 0 });
    expect(res.body.plan).toEqual({ subscriptionId: plan.id, monthlyAmountCents: 30000 });
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(10000);

    // Restating the same follow-up budget charges nothing more this period.
    res = await put([[COLD, REPLY, 30000]]);
    expect(res.status).toBe(200);
    expect(res.body.reactiveChargedCents).toBe(0);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(res.body.plan.monthlyAmountCents).toBe(40000);

    const body = await salesBudget();
    expect(body.mode).toBe("items");
    const entry = body.items.find((i: { featureSlug: string }) => i.featureSlug === COLD);
    expect(entry).toMatchObject({
      period: "month",
      budgetCents: "30000.0000000000",
      role: "proactive",
      managed: true,
      periodStart: plan.currentPeriodStart.toISOString(),
      periodEnd: plan.currentPeriodEnd.toISOString(),
    });
    // The same row's daily ceiling is the monthly budget over 30 days.
    expect(item(res.body, COLD, REPLY)).toMatchObject({ budgetCents: 30000, dailyBudgetCents: "1000.0000000000" });
    expect(body.dailyBudgetCents).toBe("1333.3333333333");
  });

  it("subscriber: a legacy daily row is served in MONTH with its cap and minimum, then flips when restated", async () => {
    await subscriber();
    await db.insert(campaignDailyBudgets).values([
      { orgId, brandId: BRAND, offerId: OFFER, featureSlug: COLD, legKey: REPLY, dailyBudgetCents: "5000", updatedAt: new Date() },
      { orgId, brandId: BRAND, offerId: OFFER, featureSlug: MEET, legKey: MEET_LEG, dailyBudgetCents: "5000", updatedAt: new Date() },
    ]);
    let res = await request(app).get(itemsPath).set(headers);
    expect(res.body.period).toBe("month");
    expect(item(res.body, COLD, REPLY)).toMatchObject({
      period: "month",
      statedPeriod: "day",
      budgetCents: 150000,
      dailyBudgetCents: "5000.0000000000",
      minimumCents: 9900,
    });
    expect(item(res.body, MEET, MEET_LEG)).toMatchObject({ period: "month", statedPeriod: "day", budgetCents: 150000, capCents: 75000 });

    res = await put([[COLD, REPLY, 30000], [MEET, MEET_LEG, 15000]]);
    expect(res.status).toBe(200);
    expect(item(res.body, COLD, REPLY)).toMatchObject({ period: "month", statedPeriod: "month", budgetCents: 30000, dailyBudgetCents: "1000.0000000000" });
    expect(item(res.body, MEET, MEET_LEG)).toMatchObject({ statedPeriod: "month", budgetCents: 15000, capCents: 15000 });
  });

  it("subscriber: an OFF campaign keeps its budget and is charged nothing; turning it ON charges its follow-up", async () => {
    const plan = await subscriber();
    onCampaigns.delete(`${MEET}:${MEET_LEG}`);
    let res = await put([[COLD, REPLY, 20000], [MEET, MEET_LEG, 10000]]);
    expect(res.status).toBe(200);
    expect(res.body.reactiveChargedCents).toBe(0);
    expect(res.body.pricing).toMatchObject({ monthlyAmountCents: 20000, reactiveMonthlyCents: 0, offMonthlyCents: 10000 });
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
    expect(item(res.body, MEET, MEET_LEG)).toMatchObject({ budgetCents: 10000 });

    // campaign-service reports the follow-up campaign turned ON.
    onCampaigns.add(`${MEET}:${MEET_LEG}`);
    const hook = await request(app)
      .post(`/internal/brands/${BRAND}/mission-status-changed`)
      .set({ ...internal, "x-user-id": userId })
      .send({
        campaignId: "00000000-0000-4000-8000-0000000000c1",
        featureSlug: MEET,
        offerId: OFFER,
        legKey: MEET_LEG,
        fromStatus: null,
        toStatus: "ongoing",
      });
    expect(hook.status).toBe(202);
    await vi.waitFor(async () => {
      expect((await listLiveSubscriptions(orgId))[0].monthlyAmountCents).toBe(30000);
    });
    // A second trigger for the same move (concurrent or retried) charges nothing more.
    await onCampaignStatusChanged({ orgId, brandId: BRAND, offerId: OFFER });
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(10000);
    expect((await listLiveSubscriptions(orgId))[0].monthlyAmountCents).toBe(30000);
    expect(plan.id).toBeTruthy();
  });

  it("subscriber: a refused follow-up charge writes nothing; no plan / unreadable status refused", async () => {
    await insertTestAccount({ orgId, paymentMode: "subscription" });
    let res = await put([[COLD, REPLY, 20000]]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("no_plan_for_offer");
    await cleanTestData();

    await subscriber();
    campaignStatusDown = true;
    res = await put([[COLD, REPLY, 20000]]);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("campaign_status_unavailable");
    campaignStatusDown = false;

    ssMocks.reloadOffSession.mockResolvedValueOnce({ status: "failed", failure_code: "insufficient_funds", failure_message: "Your card has insufficient funds." });
    res = await put([[COLD, REPLY, 20000], [MEET, MEET_LEG, 10000]]);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "reactive_charge_declined", error: "Your card has insufficient funds." });
    expect(await db.select().from(campaignDailyBudgets)).toHaveLength(0);
    expect((await listLiveSubscriptions(orgId))[0].monthlyAmountCents).toBe(9900);
  });

  it("a channel we do not run: recorded, charged nothing, then enters the plan at the renewal after it launches", async () => {
    const plan = await subscriber();
    const res = await put([[META, VISIT, 150000]]);
    expect(res.status).toBe(200);
    expect(item(res.body, META, VISIT)).toMatchObject({ managed: false, budgetCents: 150000 });
    expect(res.body.pricing).toBeNull();
    expect(res.body.plan.monthlyAmountCents).toBe(9900);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();

    __primeSalesPathTerms(catalogue(true));
    await advanceSubscription(plan, new Date(plan.currentPeriodEnd.getTime() + HOUR));
    const charges = await db.select().from(subscriptionCharges).where(eq(subscriptionCharges.subscriptionId, plan.id));
    const renewal = charges.find((c) => c.periodStart.getTime() === plan.currentPeriodEnd.getTime());
    expect(renewal?.amountCents).toBe(150000);
    expect(ssMocks.reloadOffSession.mock.calls.at(-1)?.[1]).toBe(150000);
  });

  it("unspent follow-up credit carries over at the boundary instead of expiring", async () => {
    const plan = await subscriber();
    expect((await put([[COLD, REPLY, 9900], [MEET, MEET_LEG, 4900]])).status).toBe(200);
    expect(await db.select().from(salesPathReactiveCharges)).toHaveLength(1);

    // Paid in: the $99 plan + the $49 follow-up charge. Spent: the whole entry month and
    // $10 of meetings. Left: $39 of follow-up credit.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("14800.0000000000");
    setUsage("10900.0000000000");
    const boundary = plan.currentPeriodEnd;
    await advanceSubscription(plan, new Date(boundary.getTime() + HOUR));

    const [expiry] = await db.select().from(subscriptionCreditExpiries).where(eq(subscriptionCreditExpiries.subscriptionId, plan.id));
    expect(expiry.amountCents).toBe("0.0000000000");
    expect(expiry.carriedOverCents).toBe("3900.0000000000");

    const [renewal] = await db.select().from(subscriptionCharges).where(eq(subscriptionCharges.periodStart, boundary));
    expect(renewal).toMatchObject({ amountCents: 14800, reactiveCents: 4900 });

    const body = await salesBudget();
    const meet = body.items.find((i: { featureSlug: string }) => i.featureSlug === MEET);
    expect(meet.budgetCents).toBe("8800.0000000000");
  });

  it("entry credit left at the boundary still expires (only follow-up credit carries)", async () => {
    const plan = await subscriber();
    expect((await put([[COLD, REPLY, 9900], [MEET, MEET_LEG, 4900]])).status).toBe(200);
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("14800.0000000000");
    setUsage("0.0000000000");
    await advanceSubscription(plan, new Date(plan.currentPeriodEnd.getTime() + HOUR));
    const [expiry] = await db.select().from(subscriptionCreditExpiries).where(eq(subscriptionCreditExpiries.subscriptionId, plan.id));
    expect(expiry.carriedOverCents).toBe("4900.0000000000");
    expect(expiry.amountCents).toBe("9900.0000000000");
  });
});
