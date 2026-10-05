/**
 * A MONTHLY campaign budget in ANY payment mode (owner 2026-10-05, lib/campaign-items).
 * Pins:
 *   - a prepaid / postpaid org states `period: "month"`: whole dollars, the MONTHLY
 *     minimum, the follow-up cap computed in month; NOTHING is charged and no plan is
 *     touched; the daily ceiling is monthly / 30;
 *   - the offer view serves each row in the period it was stated in (a $120/month row
 *     reads $120/month, its minimum and cap in month too), a daily row stays daily;
 *   - campaign-service's items read serves it with the UTC calendar month as period;
 *   - a subscriber may not state "day"; absent `period` behaves exactly as before.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { campaignDailyBudgets, subscriptions } from "../../src/db/schema.js";
import { calendarMonthOf } from "../../src/lib/campaign-items.js";
import {
  __primeSalesPathTerms,
  __resetSalesPathTerms,
  type PublishedSalesChannel,
} from "../../src/lib/sales-path-terms.js";

const orgId = "00000000-0000-0000-0000-0000000066a1";
const userId = "00000000-0000-0000-0000-0000000066a9";
const headers = getAuthHeaders(orgId, userId);
const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };

const BRAND = "aaaaaaaa-0066-4000-8000-000000000001";
const OFFER = "aaaaaaaa-0066-4000-8000-0000000000a1";
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
      { legKey: REPLY, from: null, minimumMonthlyBudgetCents: 9900 },
      { legKey: VISIT, from: null, minimumMonthlyBudgetCents: 9900 },
    ],
  },
  {
    slug: MEET,
    operatedBy: "platform",
    managed: true,
    stepTransitions: [{ legKey: MEET_LEG, from: { key: "conversation" }, minimumMonthlyBudgetCents: 0 }],
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("monthly campaign budgets in any payment mode", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    __resetSalesPathTerms();
    __primeSalesPathTerms(CATALOGUE);

    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@new.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");

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
    vi.spyOn(cs, "fetchRecurringCampaignStatuses").mockResolvedValue({
      ok: true,
      campaigns: [`${COLD}:${REPLY}`, `${MEET}:${MEET_LEG}`].map((k, i) => {
        const [featureSlug, legKey] = k.split(":");
        return {
          campaignId: `00000000-0000-4000-8000-00000000066${i}`,
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
    });

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({ org_id: orgId, spent_cents: "0.0000000000", as_of: "2026-10-01T00:00:00.000Z" });
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({ org_id: orgId, spent_cents: "0.0000000000", as_of: "2026-10-01T00:00:00.000Z" });
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue("00000000-0000-0000-0000-00000000a066");
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

  function put(items: Array<[string, string, number]>, period?: "day" | "month") {
    return request(app)
      .put(itemsPath)
      .set(headers)
      .send({
        items: items.map(([featureSlug, legKey, budgetCents]) => ({ featureSlug, legKey, budgetCents })),
        ...(period ? { period } : {}),
      });
  }

  function item(body: { items: Array<{ featureSlug: string; legKey: string }> }, slug: string, leg: string) {
    return body.items.find((i) => i.featureSlug === slug && i.legKey === leg) as Record<string, unknown> | undefined;
  }

  for (const paymentMode of ["prepaid", "postpaid"] as const) {
    it(`${paymentMode}: a monthly budget is stored, served in month, charged nothing`, async () => {
      await insertTestAccount({ orgId, paymentMode });
      const res = await put([[COLD, REPLY, 12000], [MEET, MEET_LEG, 6000]], "month");
      expect(res.status).toBe(200);
      expect(res.body.reactiveChargedCents).toBe(0);
      expect(res.body.period).toBe("day"); // the org's default is unchanged
      expect(res.body.plan).toBeNull();
      expect(res.body.pricing).toBeNull();
      expect(item(res.body, COLD, REPLY)).toMatchObject({
        period: "month",
        statedPeriod: "month",
        budgetCents: 12000,
        dailyBudgetCents: "400.0000000000",
        minimumCents: 9900,
      });
      expect(item(res.body, MEET, MEET_LEG)).toMatchObject({ period: "month", budgetCents: 6000, capCents: 6000 });
      expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
      expect(await db.select().from(subscriptions)).toHaveLength(0);
      const rows = await db.select().from(campaignDailyBudgets);
      expect(rows.map((r) => [r.featureSlug, r.monthlyBudgetCents, r.planDerived]).sort()).toEqual([
        [MEET, 6000, false],
        [COLD, 12000, false],
      ].sort());
    });
  }

  it("prepaid: the monthly rules hold (whole dollars, monthly minimum, follow-up cap in month)", async () => {
    await insertTestAccount({ orgId, paymentMode: "prepaid" });
    let res = await put([[COLD, REPLY, 12050]], "month");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("amount_not_whole_dollars");
    res = await put([[COLD, REPLY, 9000]], "month");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "below_minimum", minimumCents: 9900, period: "month" });
    res = await put([[COLD, REPLY, 12000], [MEET, MEET_LEG, 6100]], "month");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "reactive_above_cap", capCents: 6000, period: "month" });
    expect(await db.select().from(campaignDailyBudgets)).toHaveLength(0);
  });

  it("prepaid: a daily row next to a monthly one keeps its own period; absent period = day as before", async () => {
    await insertTestAccount({ orgId, paymentMode: "prepaid" });
    expect((await put([[COLD, REPLY, 12000]], "month")).status).toBe(200);
    const res = await put([[COLD, VISIT, 500]]);
    expect(res.status).toBe(200);
    expect(item(res.body, COLD, VISIT)).toMatchObject({ period: "day", statedPeriod: "day", budgetCents: 500 });
    expect(item(res.body, COLD, REPLY)).toMatchObject({ period: "month", budgetCents: 12000 });
  });

  it("campaign-service reads a prepaid monthly budget over the UTC calendar month", async () => {
    await insertTestAccount({ orgId, paymentMode: "prepaid" });
    expect((await put([[COLD, REPLY, 12000]], "month")).status).toBe(200);
    const sb = await request(app).get(`/internal/brands/${BRAND}/sales-budget`).set(internal);
    expect(sb.status).toBe(200);
    expect(sb.body.mode).toBe("items");
    const month = calendarMonthOf(new Date());
    expect(sb.body.items).toEqual([
      expect.objectContaining({
        featureSlug: COLD,
        legKey: REPLY,
        period: "month",
        budgetCents: "12000.0000000000",
        periodStart: month.start.toISOString(),
        periodEnd: month.end.toISOString(),
      }),
    ]);
  });

  it("calendar month: UTC first of the month to the next first, December rolls the year", () => {
    expect(calendarMonthOf(new Date("2026-10-05T23:59:00Z"))).toEqual({
      start: new Date("2026-10-01T00:00:00Z"),
      end: new Date("2026-11-01T00:00:00Z"),
    });
    expect(calendarMonthOf(new Date("2026-12-31T12:00:00Z")).end).toEqual(new Date("2027-01-01T00:00:00Z"));
  });

  it("a subscriber may not state a daily budget", async () => {
    await insertTestAccount({ orgId, paymentMode: "subscription" });
    const res = await put([[COLD, REPLY, 500]], "day");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("period_not_allowed");
    expect(await db.select().from(campaignDailyBudgets)).toHaveLength(0);
  });
});
