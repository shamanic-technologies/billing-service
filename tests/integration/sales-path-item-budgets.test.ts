/**
 * SALES-PATH ITEM BUDGETS (owner 2026-10-04, lib/sales-path-items). Pins:
 *   - a daily (prepaid / postpaid) item clears its published minimum over 30 days;
 *     a reactive item is at most 50% of its path's entry item; customer-team legs
 *     and a second entry are refused, each with a legible code;
 *   - one active path per entry: entry_taken, unless replacePathKey names the holder;
 *   - campaign-service reads mode "items" on the sales-budget read; a brand with no
 *     item reads exactly as before;
 *   - subscriber: the plan becomes the SUM of its items (min $99), the reactive part
 *     is charged NOW (once), a refused card writes nothing;
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
  salesPathItemBudgets,
  salesPathReactiveCharges,
  subscriptionCharges,
  subscriptionCreditExpiries,
} from "../../src/db/schema.js";
import { advanceSubscription, listLiveSubscriptions } from "../../src/lib/subscription.js";
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

describe("sales-path item budgets", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let setUsage: (cents: string) => void;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    __resetSalesPathTerms();
    __primeSalesPathTerms(catalogue());

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

  const itemsPath = `/v1/brands/${BRAND}/offers/${OFFER}/sales-path-budgets`;

  function put(pathKey: string, items: Array<[string, string, number]>, replacePathKey?: string) {
    return request(app)
      .put(itemsPath)
      .set(headers)
      .send({
        pathKey,
        items: items.map(([featureSlug, legKey, budgetCents]) => ({ featureSlug, legKey, budgetCents })),
        ...(replacePathKey ? { replacePathKey } : {}),
      });
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

  it("a brand with no item reads exactly as before (campaigns mode, no items field)", async () => {
    await insertTestAccount({ orgId });
    const body = await salesBudget();
    expect(body).toEqual({ brandId: BRAND, orgId, mode: "campaigns", dailyBudgetCents: null, updatedAt: null });
  });

  it("daily items: minimum over 30 days, 50% reactive cap, customer leg and second entry refused", async () => {
    await insertTestAccount({ orgId });
    let res = await put("p1", [[COLD, REPLY, 329]]);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "below_minimum", minimumCents: 330, period: "day", featureSlug: COLD });

    res = await put("p1", [[COLD, REPLY, 1000], [MEET, MEET_LEG, 501]]);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "reactive_above_cap", capCents: 500, featureSlug: MEET });

    res = await put("p1", [[COLD, REPLY, 1000], [TEAM, MEET_LEG, 100]]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("customer_leg_has_no_budget");

    res = await put("p1", [[COLD, REPLY, 1000], [COLD, VISIT, 1000]]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("one_entry_item_per_path");

    res = await put("p1", [[MEET, MEET_LEG, 500]]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("entry_item_required");

    res = await put("p1", [[COLD, "no_such_leg", 1000]]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("unknown_item");

    expect(await db.select().from(salesPathItemBudgets)).toHaveLength(0);

    res = await put("p1", [[COLD, REPLY, 1000], [MEET, MEET_LEG, 500]]);
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("day");
    expect(res.body.paths).toHaveLength(1);
    expect(res.body.paths[0].items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ featureSlug: COLD, role: "proactive", budgetCents: 1000, minimumCents: 330, managed: true }),
        expect.objectContaining({ featureSlug: MEET, role: "reactive", budgetCents: 500, capCents: 500 }),
      ])
    );
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();

    const body = await salesBudget();
    expect(body.mode).toBe("items");
    // Reactive items fire on leads: never added to the daily total.
    expect(body.dailyBudgetCents).toBe("1000.0000000000");
    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ offerId: OFFER, featureSlug: COLD, legKey: REPLY, budgetCents: "1000.0000000000", period: "day", periodStart: null }),
        expect.objectContaining({ featureSlug: MEET, role: "reactive", budgetCents: "500.0000000000" }),
      ])
    );
    const total = await request(app).get(`/internal/brands/${BRAND}/daily-budget`).set(internal);
    expect(total.body.dailyBudgetCents).toBe("1000.0000000000");
  });

  it("one active path per entry: entry_taken, unless replacePathKey names the holder", async () => {
    await insertTestAccount({ orgId });
    expect((await put("p1", [[COLD, REPLY, 1000]])).status).toBe(200);
    // Another entry on the same offer is a second active path: allowed.
    expect((await put("p2", [[COLD, VISIT, 400]])).status).toBe(200);

    let res = await put("p3", [[COLD, REPLY, 2000]]);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "entry_taken", conflictingPathKey: "p1" });

    res = await put("p3", [[COLD, REPLY, 2000]], "p1");
    expect(res.status).toBe(200);
    expect(res.body.replacedPathKey).toBe("p1");
    expect(res.body.paths.map((p: { pathKey: string }) => p.pathKey).sort()).toEqual(["p2", "p3"]);

    res = await request(app).delete(`${itemsPath}?pathKey=p2`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
    res = await request(app).delete(`${itemsPath}?pathKey=p2`).set(headers);
    expect(res.body.removed).toBe(false);
    expect((await salesBudget()).dailyBudgetCents).toBe("2000.0000000000");
  });

  it("an unreadable catalogue refuses the write (502 minimums_unavailable), nothing stored", async () => {
    await insertTestAccount({ orgId });
    __resetSalesPathTerms();
    process.env.FEATURES_SERVICE_URL = "http://features.test";
    const res = await put("p1", [[COLD, REPLY, 1000]]);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("minimums_unavailable");
    expect(await db.select().from(salesPathItemBudgets)).toHaveLength(0);
  });

  // --- subscriber -------------------------------------------------------------

  it("subscriber: the plan becomes the SUM of its items; the reactive part is charged NOW, once", async () => {
    const plan = await subscriber();

    let res = await put("p1", [[COLD, REPLY, 20050]]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("amount_not_whole_dollars");

    res = await put("p1", [[COLD, REPLY, 20000], [MEET, MEET_LEG, 10000]]);
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("month");
    expect(res.body.reactiveChargedCents).toBe(10000);
    expect(res.body.plan).toMatchObject({
      subscriptionId: plan.id,
      monthlyAmountCents: 30000,
      reactiveMonthlyCents: 10000,
      deferredMonthlyCents: 0,
      currentMonthlyAmountCents: 30000,
    });
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(10000);

    // Restating the same reactive budget charges nothing more this period.
    res = await put("p1", [[COLD, REPLY, 30000], [MEET, MEET_LEG, 10000]]);
    expect(res.status).toBe(200);
    expect(res.body.reactiveChargedCents).toBe(0);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(res.body.plan.currentMonthlyAmountCents).toBe(40000);

    const body = await salesBudget();
    expect(body.mode).toBe("items");
    const entry = body.items.find((i: { featureSlug: string }) => i.featureSlug === COLD);
    expect(entry).toMatchObject({
      period: "month",
      budgetCents: "30000.0000000000",
      periodStart: plan.currentPeriodStart.toISOString(),
      periodEnd: plan.currentPeriodEnd.toISOString(),
    });
    // The daily total of a monthly item is its 30th.
    expect(body.dailyBudgetCents).toBe("1000.0000000000");
  });

  it("subscriber: a refused reactive charge writes nothing; no plan for the offer is refused", async () => {
    await insertTestAccount({ orgId, paymentMode: "subscription" });
    let res = await put("p1", [[COLD, REPLY, 20000]]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("no_plan_for_offer");
    await cleanTestData();

    await subscriber();
    ssMocks.reloadOffSession.mockResolvedValueOnce({ status: "failed", failure_code: "insufficient_funds", failure_message: "Your card has insufficient funds." });
    res = await put("p1", [[COLD, REPLY, 20000], [MEET, MEET_LEG, 10000]]);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "reactive_charge_declined", error: "Your card has insufficient funds." });
    expect(await db.select().from(salesPathItemBudgets)).toHaveLength(0);
    const [plan] = await listLiveSubscriptions(orgId);
    expect(plan.monthlyAmountCents).toBe(9900);
  });

  it("a channel we do not run: recorded, charged nothing, then enters the plan at the renewal after it launches", async () => {
    const plan = await subscriber();
    const res = await put("ads", [[META, VISIT, 150000]]);
    expect(res.status).toBe(200);
    expect(res.body.paths[0].items[0]).toMatchObject({ managed: false, budgetCents: 150000 });
    expect(res.body.pricing).toBeNull();
    expect(res.body.plan).toBeNull();
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
    expect((await listLiveSubscriptions(orgId))[0].monthlyAmountCents).toBe(9900);

    // We launch meta-ads: the next renewal charges the commitment.
    __primeSalesPathTerms(catalogue(true));
    await advanceSubscription(plan, new Date(plan.currentPeriodEnd.getTime() + HOUR));
    const charges = await db
      .select()
      .from(subscriptionCharges)
      .where(eq(subscriptionCharges.subscriptionId, plan.id));
    const renewal = charges.find((c) => c.periodStart.getTime() === plan.currentPeriodEnd.getTime());
    expect(renewal?.amountCents).toBe(150000);
    expect(ssMocks.reloadOffSession.mock.calls.at(-1)?.[1]).toBe(150000);
  });

  it("unspent reactive credit carries over at the boundary instead of expiring", async () => {
    const plan = await subscriber();
    expect((await put("p1", [[COLD, REPLY, 9900], [MEET, MEET_LEG, 4900]])).status).toBe(200);
    expect(await db.select().from(salesPathReactiveCharges)).toHaveLength(1);

    // Paid in: the $99 plan + the $49 reactive charge. Spent: the whole proactive month
    // and $10 of meetings. Left: $39 of reactive credit.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("14800.0000000000");
    setUsage("10900.0000000000");
    const boundary = plan.currentPeriodEnd;
    await advanceSubscription(plan, new Date(boundary.getTime() + HOUR));

    const [expiry] = await db
      .select()
      .from(subscriptionCreditExpiries)
      .where(eq(subscriptionCreditExpiries.subscriptionId, plan.id));
    expect(expiry.amountCents).toBe("0.0000000000");
    expect(expiry.carriedOverCents).toBe("3900.0000000000");

    // The renewal charges the full sum, its reactive part recorded on the charge.
    const [renewal] = await db
      .select()
      .from(subscriptionCharges)
      .where(eq(subscriptionCharges.periodStart, boundary));
    expect(renewal).toMatchObject({ amountCents: 14800, reactiveCents: 4900 });

    // campaign-service reads the reactive item with the carry-over folded in.
    const body = await salesBudget();
    const meet = body.items.find((i: { featureSlug: string }) => i.featureSlug === MEET);
    expect(meet.budgetCents).toBe("8800.0000000000");
  });

  it("proactive credit left at the boundary still expires (only reactive carries)", async () => {
    const plan = await subscriber();
    expect((await put("p1", [[COLD, REPLY, 9900], [MEET, MEET_LEG, 4900]])).status).toBe(200);
    // Nothing spent: $148 left, of which at most the $49 reactive carries.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("14800.0000000000");
    setUsage("0.0000000000");
    await advanceSubscription(plan, new Date(plan.currentPeriodEnd.getTime() + HOUR));
    const [expiry] = await db
      .select()
      .from(subscriptionCreditExpiries)
      .where(eq(subscriptionCreditExpiries.subscriptionId, plan.id));
    expect(expiry.carriedOverCents).toBe("4900.0000000000");
    expect(expiry.amountCents).toBe("9900.0000000000");
  });
});
