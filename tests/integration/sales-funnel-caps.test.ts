/**
 * MAX BUDGET + MAX VOLUME per brand x offer x SALES FUNNEL (migration 0078,
 * lib/sales-funnel-caps.ts): stated, read back with what the funnel consumed in
 * the current period, cleared, and never touching the per-campaign ceilings.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { brandSalesBudgets, campaignDailyBudgets, salesFunnelCapChanges, salesFunnelCaps } from "../../src/db/schema.js";
import { __resetSalesFunnelCache } from "../../src/lib/sales-funnel-catalogue.js";
import { __primeSalesPathTerms, __resetSalesPathTerms } from "../../src/lib/sales-path-terms.js";

const orgId = "00000000-0000-0000-0000-0000000078a1";
const otherOrgId = "00000000-0000-0000-0000-0000000078a2";
const userId = "00000000-0000-0000-0000-0000000078a9";
const runId = "00000000-0000-0000-0000-0000000078ab";
const brandId = "00000000-0000-0000-0000-000000078b01";
const OFFER = "aaaaaaaa-1178-4178-8178-aaaaaaaaaaaa";
const OTHER_OFFER = "bbbbbbbb-1178-4178-8178-bbbbbbbbbbbb";

const COLD = "sales-cold-email-outreach";
const BOOKING = "ai-meeting-booking";
const FUNNEL =
  "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
const ADS_FUNNEL = "start_to_website_visit@google-ads+website_visit_to_purchase+purchase_to_paid_client";
// Every pipe reactive: contacts nobody first.
const REACTIVE_FUNNEL = "conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";

const CAMPAIGN_COLD = "11111111-0000-4000-8000-000000000001";
const CAMPAIGN_COLD_LEGACY = "11111111-0000-4000-8000-000000000002";
const CAMPAIGN_BOOKING = "11111111-0000-4000-8000-000000000003";
const CAMPAIGN_OTHER_OFFER = "11111111-0000-4000-8000-000000000004";
const CAMPAIGN_OTHER_LEG = "11111111-0000-4000-8000-000000000005";
// Lead sources (Start -> Lead found) feeding cold email, as features-service publishes them.
const APOLLO = "sourcing-apollo-cold-filters";
const SIGNALS = "sourcing-linkedin-engagement-signals";
const CRM = "sourcing-crm-contacts";
const CAMPAIGN_SOURCE_APOLLO = "11111111-0000-4000-8000-000000000006";
const CAMPAIGN_SOURCE_SIGNALS = "11111111-0000-4000-8000-000000000007";
const CAMPAIGN_SOURCE_CRM = "11111111-0000-4000-8000-000000000008";
const CAMPAIGN_SOURCE_OTHER_OFFER = "11111111-0000-4000-8000-000000000009";
const ORIGINS = {
  sourceLegKey: "start_to_lead_found",
  origins: [{ slug: APOLLO }, { slug: SIGNALS }, { slug: CRM }],
  originsByChannel: {
    "sales-cold-email-outreach": [APOLLO, SIGNALS],
    "sales-crm-email-outreach": [CRM],
  },
};

const app = createTestApp();
const auth = getAuthHeaders(orgId, userId, runId);
const internal = (org: string) => ({ "X-API-Key": "test-api-key", "x-org-id": org });
const capsPath = (funnel = FUNNEL, offer = OFFER) =>
  `/brands/${brandId}/offers/${offer}/sales-funnels/${encodeURIComponent(funnel)}/caps`;

const funnelDetail = (id: string) =>
  id === FUNNEL
    ? {
        object: "sales_funnel",
        id,
        name: "Victory",
        type: "proactive",
        legs: [
          { legKey: "lead_found_to_conversation", pipe: { id: `${COLD}|lead_found_to_conversation`, mode: "proactive" } },
          { legKey: "conversation_to_meeting_booked", pipe: { id: `${BOOKING}|conversation_to_meeting_booked`, mode: "reactive" } },
          { legKey: "meeting_booked_to_meeting_attended", pipe: null },
          { legKey: "meeting_attended_to_paid_client", pipe: null },
        ],
      }
    : id === ADS_FUNNEL
      ? {
          object: "sales_funnel",
          id,
          name: "Mirage",
          legs: [{ legKey: "start_to_website_visit", pipe: { id: "google-ads|start_to_website_visit", mode: "proactive" } }],
        }
      : id === REACTIVE_FUNNEL
        ? {
            object: "sales_funnel",
            id,
            name: "Echo",
            type: "reactive",
            legs: [
              { legKey: "conversation_to_meeting_booked", pipe: { id: `${BOOKING}|conversation_to_meeting_booked`, mode: "reactive" } },
              { legKey: "meeting_booked_to_meeting_attended", pipe: null },
              { legKey: "meeting_attended_to_paid_client", pipe: null },
            ],
          }
        : null;

const campaign = (id: string, offerId: string, featureSlug: string, legKey: string) => ({
  campaignId: id,
  orgId,
  brandId,
  offerId,
  featureSlug,
  legKey,
  status: "ongoing",
  running: true,
  executedByPlatform: true,
  kind: "proactive",
  audience: "available",
  allAudiencesExhausted: false,
  recurring: true,
});

interface Calls {
  costs: URLSearchParams[];
  outcomes: URLSearchParams[];
  runs: URLSearchParams[];
  features: number;
  campaigns: number;
}

function mockUpstreams(opts: { featuresStatus?: number; runsStatus?: number } = {}): Calls {
  const calls: Calls = { costs: [], outcomes: [], runs: [], features: 0, campaigns: 0 };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/internal/catalogue/sales-funnels/")) {
      calls.features += 1;
      if (opts.featuresStatus) return new Response("boom", { status: opts.featuresStatus });
      const body = funnelDetail(decodeURIComponent(url.pathname.split("/").pop()!));
      return body ? Response.json(body) : Response.json({ reason: "sales_funnel_not_found" }, { status: 404 });
    }
    if (url.pathname === "/internal/campaigns/recurring-status") {
      calls.campaigns += 1;
      return Response.json({
        campaigns: [
          campaign(CAMPAIGN_COLD, OFFER, COLD, "lead_found_to_conversation"),
          // Same pipe, legacy leg spelling: still this pipe.
          campaign(CAMPAIGN_COLD_LEGACY, OFFER, COLD, "start_to_conversation"),
          campaign(CAMPAIGN_BOOKING, OFFER, BOOKING, "conversation_to_meeting_booked"),
          campaign(CAMPAIGN_OTHER_OFFER, OTHER_OFFER, COLD, "lead_found_to_conversation"),
          campaign(CAMPAIGN_OTHER_LEG, OFFER, COLD, "lead_found_to_website_visit"),
          campaign(CAMPAIGN_SOURCE_APOLLO, OFFER, APOLLO, "start_to_lead_found"),
          campaign(CAMPAIGN_SOURCE_SIGNALS, OFFER, SIGNALS, "start_to_lead_found"),
          // A source feeding a channel the funnel has no pipe on, and another offer's source: not counted.
          campaign(CAMPAIGN_SOURCE_CRM, OFFER, CRM, "start_to_lead_found"),
          campaign(CAMPAIGN_SOURCE_OTHER_OFFER, OTHER_OFFER, APOLLO, "start_to_lead_found"),
        ],
      });
    }
    if (url.pathname === "/v1/stats/costs") {
      calls.costs.push(url.searchParams);
      if (opts.runsStatus) return new Response("down", { status: opts.runsStatus });
      return Response.json({
        groups: url.searchParams
          .get("campaignIds")!
          .split(",")
          .map((id) => ({ dimensions: { campaignId: id }, totalCostInUsdCents: "999", netTotalCostInUsdCents: "1000.5" })),
      });
    }
    if (url.pathname === "/v1/runs") {
      calls.runs.push(url.searchParams);
      if (opts.runsStatus) return new Response("down", { status: opts.runsStatus });
      // A reactive pipe's LLM completions: two under one workflow run (one prospect),
      // one under another, one failed, one still running under a third.
      return Response.json({
        runs: [
          { id: "r1", parentRunId: "w1", status: "completed" },
          { id: "r2", parentRunId: "w1", status: "completed" },
          { id: "r3", parentRunId: "w2", status: "completed" },
          { id: "r4", parentRunId: "w9", status: "failed" },
          { id: "r5", parentRunId: "w3", status: "running" },
        ],
      });
    }
    if (url.pathname === "/v1/stats/run-outcomes") {
      calls.outcomes.push(url.searchParams);
      if (opts.runsStatus) return new Response("down", { status: opts.runsStatus });
      return Response.json({
        scope: "all",
        groups: url.searchParams
          .get("campaignIds")!
          .split(",")
          .map((id) => ({ dimensions: { campaignId: id }, runCount: 40, completedCount: 30, failedCount: 4, runningCount: 6 })),
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

const put = (body: unknown, funnel = FUNNEL, offer = OFFER) =>
  request(app).put(`/v1${capsPath(funnel, offer)}`).set(auth).send(body as object);
const readInternal = (funnel = FUNNEL, org = orgId) =>
  request(app).get(`/internal${capsPath(funnel)}`).set(internal(org));

describe("sales funnel caps", () => {
  const savedEnv = { ...process.env };
  beforeAll(() => {
    process.env.FEATURES_SERVICE_API_KEY = "test-features-key";
    process.env.CAMPAIGN_SERVICE_URL = "http://localhost:9994";
    process.env.CAMPAIGN_SERVICE_API_KEY = "test-campaign-key";
  });
  beforeEach(async () => {
    await cleanTestData();
    __resetSalesFunnelCache();
    __primeSalesPathTerms([], ORIGINS as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetSalesPathTerms();
  });
  afterAll(async () => {
    for (const k of ["FEATURES_SERVICE_API_KEY", "CAMPAIGN_SERVICE_URL", "CAMPAIGN_SERVICE_API_KEY"]) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await cleanTestData();
    await closeDb();
  });

  it("nothing stated: stated false, both caps null, the funnel still named with its relayed type + unit, no measurement", async () => {
    const calls = mockUpstreams();
    const res = await readInternal();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orgId,
      brandId,
      offerId: OFFER,
      salesFunnelId: FUNNEL,
      stated: false,
      updatedAt: null,
      maxBudget: null,
      maxVolume: null,
      salesFunnelName: "Victory",
      salesFunnelType: "proactive",
      salesFunnelTypeUnavailableReason: null,
      volumeUnit: "first_contacts",
      pipes: null,
      sources: null,
    });
    expect(calls.features).toBe(1);
    expect(calls.campaigns + calls.costs.length + calls.outcomes.length).toBe(0);
  });

  it("$50 weekly + 200 per month reads back with what the funnel consumed this period", async () => {
    const calls = mockUpstreams();
    const res = await put({
      maxBudget: { amountCents: 5000, period: "weekly" },
      maxVolume: { count: 200, period: "monthly" },
    });
    expect(res.status).toBe(200);

    const read = await readInternal();
    expect(read.status).toBe(200);
    const b = read.body;
    expect(b.stated).toBe(true);
    expect(b.salesFunnelName).toBe("Victory");
    expect(b.salesFunnelType).toBe("proactive");
    expect(b.salesFunnelTypeUnavailableReason).toBeNull();
    expect(b.volumeUnit).toBe("first_contacts");

    // Spend is ALL-INCLUSIVE: every campaign of the funnel's pipes for this brand x
    // offer (both spellings of the cold leg + the booking campaign) AND the lead
    // sources feeding cold email; never another offer, leg or unfed source.
    const spendIds = calls.costs.at(-1)!.get("campaignIds")!.split(",").sort();
    expect(spendIds).toEqual(
      [CAMPAIGN_COLD, CAMPAIGN_COLD_LEGACY, CAMPAIGN_BOOKING, CAMPAIGN_SOURCE_APOLLO, CAMPAIGN_SOURCE_SIGNALS].sort()
    );
    expect(b.maxBudget).toMatchObject({
      amountCents: "5000.0000000000",
      period: "weekly",
      consumedCents: "5002.5000000000",
      remainingCents: "0.0000000000",
      reached: true,
      consumedUnavailableReason: null,
    });
    // The week starts on a Monday, UTC, and lasts 7 days.
    const start = new Date(b.maxBudget.periodStart);
    expect(start.getUTCDay()).toBe(1);
    expect(start.getUTCHours()).toBe(0);
    expect(new Date(b.maxBudget.periodEnd).getTime() - start.getTime()).toBe(7 * 86_400_000);
    expect(calls.costs.at(-1)!.get("startedAfter")).toBe(b.maxBudget.periodStart);

    // Volume: first contacts of the PROACTIVE pipe only (cold email first emails).
    const volumeCall = calls.outcomes.at(-1)!;
    expect(volumeCall.get("campaignIds")!.split(",").sort()).toEqual([CAMPAIGN_COLD, CAMPAIGN_COLD_LEGACY].sort());
    expect(volumeCall.get("serviceName")).toBe("instantly-service");
    expect(volumeCall.get("taskName")).toBe("email-send-step-1");
    expect(b.maxVolume).toMatchObject({
      count: 200,
      period: "monthly",
      unit: "first_contacts",
      consumed: 72,
      remaining: 128,
      reached: false,
      consumedUnavailableReason: null,
    });
    expect(b.maxVolume.periodStart).toMatch(/-01T00:00:00.000Z$/);

    expect(b.pipes).toEqual([
      {
        pipeId: `${COLD}|lead_found_to_conversation`,
        channelSlug: COLD,
        legKey: "lead_found_to_conversation",
        mode: "proactive",
        campaignIds: [CAMPAIGN_COLD, CAMPAIGN_COLD_LEGACY].sort(),
      },
      {
        pipeId: `${BOOKING}|conversation_to_meeting_booked`,
        channelSlug: BOOKING,
        legKey: "conversation_to_meeting_booked",
        mode: "reactive",
        campaignIds: [CAMPAIGN_BOOKING],
      },
    ]);

    expect(b.sources).toEqual([
      {
        channelSlug: SIGNALS,
        legKey: "start_to_lead_found",
        feedsPipeIds: [`${COLD}|lead_found_to_conversation`],
        campaignIds: [CAMPAIGN_SOURCE_SIGNALS],
      },
      {
        channelSlug: APOLLO,
        legKey: "start_to_lead_found",
        feedsPipeIds: [`${COLD}|lead_found_to_conversation`],
        campaignIds: [CAMPAIGN_SOURCE_APOLLO],
      },
    ].sort((x, y) => x.channelSlug.localeCompare(y.channelSlug)));

    // The user read answers the same caps.
    const v1 = await request(app).get(`/v1${capsPath()}`).set(auth);
    expect(v1.status).toBe(200);
    expect(v1.body.maxBudget.amountCents).toBe("5000.0000000000");
  });

  it("reached: a cap at or below what was consumed reads reached, nothing remains", async () => {
    mockUpstreams();
    await put({ maxBudget: { amountCents: "3000", period: "daily" }, maxVolume: { count: 72, period: "one_off" } });
    const b = (await readInternal()).body;
    expect(b.maxBudget).toMatchObject({ reached: true, remainingCents: "0.0000000000" });
    expect(b.maxVolume).toMatchObject({ reached: true, remaining: 0, periodEnd: null });
  });

  it("a monthly / one-off budget above $9,999.99 is stored (the 2026-10-10 overflow), up to 12 integer digits", async () => {
    mockUpstreams();
    const res = await put({ maxBudget: { amountCents: "999999999999.5", period: "one_off" }, maxVolume: null });
    expect(res.status).toBe(200);
    expect(res.body.maxBudget.amountCents).toBe("999999999999.5000000000");
    const monthly = await put({ maxBudget: { amountCents: 10_000_000, period: "monthly" }, maxVolume: null });
    expect(monthly.status).toBe(200);
    expect(monthly.body.maxBudget.amountCents).toBe("10000000.0000000000");
  });

  it("either cap can be unset; only the stated one is measured", async () => {
    const calls = mockUpstreams();
    await put({ maxBudget: null, maxVolume: { count: 10, period: "daily" } });
    const b = (await readInternal()).body;
    expect(b.maxBudget).toBeNull();
    expect(b.maxVolume.count).toBe(10);
    expect(calls.costs).toHaveLength(0);
  });

  it("one_off keeps counting from when it was first stated; a new period starts now", async () => {
    mockUpstreams();
    await put({ maxBudget: { amountCents: 1000, period: "one_off" }, maxVolume: null });
    const first = (await readInternal()).body.maxBudget.periodStart;
    await new Promise((r) => setTimeout(r, 15));
    await put({ maxBudget: { amountCents: 2000, period: "one_off" }, maxVolume: null });
    const restated = (await readInternal()).body.maxBudget;
    expect(restated.amountCents).toBe("2000.0000000000");
    expect(restated.periodStart).toBe(first);
    await put({ maxBudget: { amountCents: 2000, period: "daily" }, maxVolume: null });
    await new Promise((r) => setTimeout(r, 15));
    await put({ maxBudget: { amountCents: 2000, period: "one_off" }, maxVolume: null });
    expect((await readInternal()).body.maxBudget.periodStart > first).toBe(true);
  });

  it("clears with both null or DELETE (idempotent), journaling each real change", async () => {
    mockUpstreams();
    await put({ maxBudget: { amountCents: 1000, period: "daily" }, maxVolume: null });
    const cleared = await put({ maxBudget: null, maxVolume: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.stated).toBe(false);
    const del = await request(app).delete(`/v1${capsPath()}`).set(auth);
    expect(del.status).toBe(200);
    expect(del.body.stated).toBe(false);
    expect(await db.select().from(salesFunnelCaps)).toHaveLength(0);
    const history = await db.select().from(salesFunnelCapChanges);
    expect(history.map((h) => [h.maxBudgetCents, h.maxBudgetPeriod, h.changedByUserId])).toEqual([
      ["1000.0000000000", "daily", userId],
      [null, null, userId],
    ]);
  });

  it("a funnel features-service does not know is refused (404), an unreadable catalogue is 502; nothing stored", async () => {
    mockUpstreams();
    const unknown = await put({ maxBudget: { amountCents: 1000, period: "daily" }, maxVolume: null }, "nope_to_nothing");
    expect(unknown.status).toBe(404);
    expect(unknown.body.reason).toBe("sales_funnel_not_found");
    vi.restoreAllMocks();
    __resetSalesFunnelCache();
    mockUpstreams({ featuresStatus: 500 });
    const down = await put({ maxBudget: { amountCents: 1000, period: "daily" }, maxVolume: null });
    expect(down.status).toBe(502);
    expect(down.body.reason).toBe("sales_funnel_catalogue_unavailable");
    expect(await db.select().from(salesFunnelCaps)).toHaveLength(0);
  });

  it("validates the body", async () => {
    mockUpstreams();
    const cases: unknown[] = [
      {},
      { maxBudget: null },
      { maxBudget: { amountCents: -1, period: "daily" }, maxVolume: null },
      { maxBudget: { amountCents: 100, period: "yearly" }, maxVolume: null },
      { maxBudget: null, maxVolume: { count: 1.5, period: "daily" } },
      { maxBudget: null, maxVolume: { count: -1, period: "daily" } },
      { maxBudget: { amountCents: "abc", period: "daily" }, maxVolume: null },
      { maxBudget: { amountCents: "1000000000000", period: "monthly" }, maxVolume: null },
    ];
    for (const body of cases) {
      const res = await put(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const badOffer = await request(app).get(`/internal/brands/${brandId}/offers/not-a-uuid/sales-funnels/x/caps`).set(internal(orgId));
    expect(badOffer.status).toBe(400);
  });

  it("a measurement that fails answers null + a reason; the caps are still served", async () => {
    mockUpstreams({ runsStatus: 503 });
    await put({ maxBudget: { amountCents: 1000, period: "daily" }, maxVolume: { count: 5, period: "daily" } });
    const res = await readInternal();
    expect(res.status).toBe(200);
    expect(res.body.maxBudget).toMatchObject({
      amountCents: "1000.0000000000",
      consumedCents: null,
      remainingCents: null,
      reached: null,
      consumedUnavailableReason: "runs_service_unavailable",
    });
    expect(res.body.maxVolume).toMatchObject({ consumed: null, reached: null, consumedUnavailableReason: "runs_service_unavailable" });
  });

  it("an unreadable sourcing catalogue leaves the budget unmeasured (never sourcing-less), volume still measured", async () => {
    __resetSalesPathTerms();
    const calls = mockUpstreams();
    await put({ maxBudget: { amountCents: 1000, period: "daily" }, maxVolume: { count: 5, period: "daily" } });
    // /public/channels + /public/sourcing-origins hit the mock and fail.
    const res = await readInternal();
    expect(res.status).toBe(200);
    expect(res.body.maxBudget).toMatchObject({
      consumedCents: null,
      reached: null,
      consumedUnavailableReason: "sourcing_catalogue_unavailable",
    });
    expect(res.body.maxVolume).toMatchObject({ consumed: 72, consumedUnavailableReason: null });
    expect(res.body.sources).toBeNull();
    expect(calls.costs).toHaveLength(0);
  });

  it("volume on a proactive channel with no first-contact measure is null with a reason, never 0", async () => {
    mockUpstreams();
    await put({ maxBudget: null, maxVolume: { count: 5, period: "daily" } }, ADS_FUNNEL);
    const res = await readInternal(ADS_FUNNEL);
    expect(res.body.maxVolume).toMatchObject({
      consumed: null,
      reached: null,
      consumedUnavailableReason: "volume_not_measured_on_channel",
    });
    expect(res.body.maxVolume.consumedUnavailableDetail).toContain("google-ads");
    // features-service served no type on this funnel: absent is null + a reason, never computed here.
    expect(res.body.salesFunnelType).toBeNull();
    expect(res.body.salesFunnelTypeUnavailableReason).toBe("type_not_served_by_features_service");
  });

  it("a reactive funnel: relayed type, volume COUNTED in prospects handled, its Up-to budget counts 0 per day", async () => {
    const calls = mockUpstreams();
    const res = await put({ maxBudget: { amountCents: 2000, period: "daily" }, maxVolume: { count: 3, period: "weekly" } }, REACTIVE_FUNNEL);
    expect(res.status).toBe(200);
    const read = await readInternal(REACTIVE_FUNNEL);
    expect(read.body.salesFunnelType).toBe("reactive");
    expect(read.body.volumeUnit).toBe("prospects_handled");
    // Distinct workflow runs that called the LLM (completed or in flight): w1, w2, w3.
    expect(read.body.maxVolume).toMatchObject({
      count: 3,
      period: "weekly",
      unit: "prospects_handled",
      consumed: 3,
      remaining: 0,
      reached: true,
      consumedUnavailableReason: null,
    });
    const runsCall = calls.runs.at(-1)!;
    expect(runsCall.get("campaignIds")).toBe(CAMPAIGN_BOOKING);
    expect(runsCall.get("serviceName")).toBe("chat-service");
    expect(runsCall.get("taskName")).toBe("complete");
    expect(runsCall.get("startedAfter")).toBe(read.body.maxVolume.periodStart);
    // The budget is still measured on the reactive pipe's campaign (hard ceiling), and counts 0 per day.
    expect(calls.costs.at(-1)!.get("campaignIds")).toBe(CAMPAIGN_BOOKING);
    expect(read.body.maxBudget).toMatchObject({ consumedCents: "1000.5000000000", dailyBudgetCents: "0.0000000000" });
    const [row] = await db.select().from(salesFunnelCaps);
    expect(row.salesFunnelType).toBe("reactive");
    // The brand's daily budget: an Up-to cap adds nothing.
    const daily = await request(app).get(`/internal/brands/${brandId}/daily-budget`).set(internal(orgId));
    expect(daily.body.dailyBudgetCents).toBeNull();
  });

  it("boot backfills the type of caps written before it was stored", async () => {
    mockUpstreams();
    await db.insert(salesFunnelCaps).values({
      orgId, brandId, offerId: OFFER, salesFunnelId: REACTIVE_FUNNEL,
      maxBudgetCents: "3000", maxBudgetPeriod: "monthly", maxBudgetSince: new Date(),
    });
    expect((await request(app).get(`/internal/brands/${brandId}/daily-budget`).set(internal(orgId))).body.dailyBudgetCents).toBe("100.0000000000");
    const { reconcileFunnelCapHistory } = await import("../../src/lib/sales-funnel-caps.js");
    await reconcileFunnelCapHistory();
    const [row] = await db.select().from(salesFunnelCaps);
    expect(row.salesFunnelType).toBe("reactive");
    expect((await request(app).get(`/internal/brands/${brandId}/daily-budget`).set(internal(orgId))).body.dailyBudgetCents).toBeNull();
  });

  it("an unreadable catalogue reads the type null with a reason", async () => {
    mockUpstreams({ featuresStatus: 503 });
    const res = await readInternal();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      stated: false,
      salesFunnelType: null,
      salesFunnelTypeUnavailableReason: "sales_funnel_catalogue_unavailable",
      volumeUnit: null,
    });
  });

  it("is org-scoped, and the brand list names every stated funnel (optionally one offer)", async () => {
    mockUpstreams();
    await put({ maxBudget: { amountCents: 5000, period: "weekly" }, maxVolume: null });
    await put({ maxBudget: null, maxVolume: { count: 3, period: "daily" } }, ADS_FUNNEL, OTHER_OFFER);
    expect((await readInternal(FUNNEL, otherOrgId)).body.stated).toBe(false);

    const list = await request(app).get(`/internal/brands/${brandId}/sales-funnel-caps`).set(internal(orgId));
    expect(list.status).toBe(200);
    expect(list.body.caps).toHaveLength(2);
    const one = await request(app)
      .get(`/v1/brands/${brandId}/sales-funnel-caps`)
      .query({ offerId: OTHER_OFFER })
      .set(auth);
    expect(one.body.caps).toEqual([
      {
        offerId: OTHER_OFFER,
        salesFunnelId: ADS_FUNNEL,
        salesFunnelType: null,
        salesFunnelTypeUnavailableReason: "type_not_served_by_features_service",
        maxBudget: null,
        maxVolume: { count: 3, period: "daily", unit: "first_contacts" },
        updatedAt: expect.any(String),
      },
    ]);
    const none = await request(app).get(`/internal/brands/${brandId}/sales-funnel-caps`).set(internal(otherOrgId));
    expect(none.body.caps).toEqual([]);
  });

  it("the brand daily budget adds every RECURRING funnel cap per day; one_off and volume-only caps add nothing", async () => {
    mockUpstreams();
    await db.insert(campaignDailyBudgets).values({
      orgId,
      brandId,
      featureSlug: COLD,
      offerId: OFFER,
      legKey: "lead_found_to_conversation",
      dailyBudgetCents: "700",
      updatedAt: new Date(),
    });
    const brandTotal = async () =>
      (await request(app).get(`/internal/brands/${brandId}/daily-budget`).set(internal(orgId))).body;
    const before = await brandTotal();
    expect(before.dailyBudgetCents).toBe("700.0000000000");

    // A one_off budget and a volume-only cap: not recurring money, the brand reads exactly as before.
    await put({ maxBudget: { amountCents: 100000, period: "one_off" }, maxVolume: null });
    await put({ maxBudget: null, maxVolume: { count: 5, period: "daily" } }, ADS_FUNNEL);
    expect(await brandTotal()).toEqual(before);

    // $70 a week = $10 a day on top of the ceilings.
    await put({ maxBudget: { amountCents: 7000, period: "weekly" }, maxVolume: null });
    expect((await brandTotal()).dailyBudgetCents).toBe("1700.0000000000");
    // A monthly cap / 30 on another funnel of another offer of the brand.
    await put({ maxBudget: { amountCents: 30000, period: "monthly" }, maxVolume: null }, ADS_FUNNEL, OTHER_OFFER);
    expect((await brandTotal()).dailyBudgetCents).toBe("2700.0000000000");
  });

  it("the by-day history records the brand's daily figure with its recurring funnel caps", async () => {
    mockUpstreams();
    const { brandDailyBudgetChanges } = await import("../../src/db/schema.js");
    const history = async () =>
      (await db.select().from(brandDailyBudgetChanges)).map((r) => r.dailyBudgetCents).sort();
    // A legacy ceiling written through the ceiling route (it journals the legacy total).
    const ceiling = await request(app)
      .put(`/v1/brands/${brandId}/campaign-budget`)
      .set(auth)
      .send({ offerId: OFFER, featureSlug: COLD, legKey: "lead_found_to_conversation", dailyBudgetCents: 800 });
    expect(ceiling.status).toBe(200);
    expect(await history()).toEqual(["800.0000000000"]);

    // One_off and volume-only caps do not move the daily figure: nothing journaled.
    await put({ maxBudget: { amountCents: 100000, period: "one_off" }, maxVolume: null });
    await put({ maxBudget: null, maxVolume: { count: 5, period: "daily" } }, ADS_FUNNEL);
    expect(await history()).toEqual(["800.0000000000"]);

    // $70 a week = $10 a day: the figure moves to 1700 and is journaled.
    await put({ maxBudget: { amountCents: 7000, period: "weekly" }, maxVolume: null });
    expect(await history()).toEqual(["1800.0000000000", "800.0000000000"]);

    // A later ceiling write journals legacy + the funnel caps, never the legacy alone.
    await request(app)
      .put(`/v1/brands/${brandId}/campaign-budget`)
      .set(auth)
      .send({ offerId: OFFER, featureSlug: COLD, legKey: "lead_found_to_conversation", dailyBudgetCents: 900 });
    expect(await history()).toContain("1900.0000000000");

    // Clearing the cap returns the figure to the legacy total.
    await request(app).delete(`/v1${capsPath()}`).set(auth);
    const rows = await db.select().from(brandDailyBudgetChanges);
    const latest = rows.sort((a, b) => +a.changedAt - +b.changedAt || a.id - b.id).at(-1)!;
    expect(latest.dailyBudgetCents).toBe("900.0000000000");

    // The by-day read agrees with the brand's current figure.
    const today = new Date().toISOString().slice(0, 10);
    const byDay = await request(app)
      .get(`/internal/brands/${brandId}/daily-budget/by-day`)
      .query({ from: today, to: today })
      .set(internal(orgId));
    expect(byDay.body.days[0].dailyBudgetCents).toBe("900.0000000000");
  });

  it("boot reconcile journals a recurring cap stated before the history counted it, once", async () => {
    const { brandDailyBudgetChanges } = await import("../../src/db/schema.js");
    const { reconcileFunnelCapHistory } = await import("../../src/lib/sales-funnel-caps.js");
    await db.insert(salesFunnelCaps).values({
      orgId, brandId, offerId: OFFER, salesFunnelId: FUNNEL,
      maxBudgetCents: "3000", maxBudgetPeriod: "monthly", maxBudgetSince: new Date(),
    });
    await reconcileFunnelCapHistory();
    await reconcileFunnelCapHistory();
    const rows = await db.select().from(brandDailyBudgetChanges);
    expect(rows.map((r) => r.dailyBudgetCents)).toEqual(["100.0000000000"]);
  });

  it("a brand funded ONLY by a funnel cap reads its daily amount, never null", async () => {
    mockUpstreams();
    const brandTotal = async () =>
      (await request(app).get(`/internal/brands/${brandId}/daily-budget`).set(internal(orgId))).body;
    expect((await brandTotal()).dailyBudgetCents).toBeNull();
    await put({ maxBudget: { amountCents: 1400, period: "weekly" }, maxVolume: null });
    expect((await brandTotal()).dailyBudgetCents).toBe("200.0000000000");
  });
  describe("campaign-service writes caps with its service identity, converting pre-funnel ceilings", () => {
    const internalPut = (body: unknown, headers: Record<string, string> = internal(orgId)) =>
      request(app).put(`/internal${capsPath()}`).set(headers).send(body as object);
    const brandDaily = async () =>
      (await request(app).get(`/internal/brands/${brandId}/daily-budget`).set(internal(orgId))).body.dailyBudgetCents;
    async function ceiling(featureSlug: string, legKey: string | null, cents: string, offerId: string | null = OFFER) {
      await db.insert(campaignDailyBudgets).values({ orgId, brandId, featureSlug, offerId, legKey, dailyBudgetCents: cents, updatedAt: new Date() });
    }

    it("accepts x-api-key + x-org-id with no user (and records none)", async () => {
      mockUpstreams();
      const res = await internalPut({ maxBudget: { amountCents: 700, period: "daily" }, maxVolume: null });
      expect(res.status).toBe(200);
      expect(res.body.conversion).toBeNull();
      const [h] = await db.select().from(salesFunnelCapChanges);
      expect(h.changedByUserId).toBeNull();
      expect((await internalPut({ maxBudget: null, maxVolume: null }, { "X-API-Key": "test-api-key" })).status).toBe(400);
    });

    it("a conversion replaces the ceilings with a cap of the same daily money: no figure moves", async () => {
      mockUpstreams();
      // The pre-funnel family: cold email (legacy leg spelling), meeting booking, its lead source;
      // plus a ceiling the conversion does not name (another offer), which must stay.
      await ceiling(COLD, "start_to_conversation", "1000");
      await ceiling(BOOKING, "conversation_to_meeting_booked", "300");
      await ceiling(APOLLO, "start_to_lead_found", "400");
      await ceiling(COLD, "lead_found_to_conversation", "900", OTHER_OFFER);
      const before = await brandDaily();
      expect(before).toBe("2600.0000000000");

      const res = await internalPut({
        maxBudget: { amountCents: 1700 * 7, period: "weekly" },
        maxVolume: null,
        replacesCeilings: [
          { featureSlug: COLD, legKey: "lead_found_to_conversation" },
          { featureSlug: BOOKING, legKey: "conversation_to_meeting_booked" },
          { featureSlug: APOLLO, legKey: "start_to_lead_found" },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.conversion).toMatchObject({
        replacedDailyCents: "1700.0000000000",
        capDailyCents: "1700.0000000000",
        brandDailyBudgetBefore: "2600.0000000000",
        brandDailyBudgetAfter: "2600.0000000000",
      });
      expect(res.body.conversion.replacedCeilings).toHaveLength(3);
      expect(await brandDaily()).toBe(before);
      const left = await db.select().from(campaignDailyBudgets);
      expect(left.map((r) => [r.featureSlug, r.offerId])).toEqual([[COLD, OTHER_OFFER]]);
      // The by-day history says the same figure.
      const { brandDailyBudgetChanges } = await import("../../src/db/schema.js");
      const rows = await db.select().from(brandDailyBudgetChanges);
      expect(rows.map((r) => r.dailyBudgetCents)).toEqual(["2600.0000000000"]);
    });

    it("refuses (409, nothing written) a conversion that would move the money, a one_off cap, or a missing ceiling", async () => {
      mockUpstreams();
      await ceiling(COLD, "lead_found_to_conversation", "1000");
      const replaces = [{ featureSlug: COLD, legKey: "lead_found_to_conversation" }];
      const more = await internalPut({ maxBudget: { amountCents: 1100, period: "daily" }, maxVolume: null, replacesCeilings: replaces });
      expect(more.status).toBe(409);
      expect(more.body).toMatchObject({ reason: "conversion_moves_budget", capDailyCents: "1100.0000000000", replacedDailyCents: "1000.0000000000" });
      const once = await internalPut({ maxBudget: { amountCents: 1000, period: "one_off" }, maxVolume: null, replacesCeilings: replaces });
      expect(once.body.reason).toBe("conversion_moves_budget");
      const missing = await internalPut({
        maxBudget: { amountCents: 1000, period: "daily" },
        maxVolume: null,
        replacesCeilings: [{ featureSlug: BOOKING, legKey: "conversation_to_meeting_booked" }],
      });
      expect(missing.body.reason).toBe("ceiling_not_found");
      // Monthly / 30 within a cent is accepted.
      const monthly = await internalPut({ maxBudget: { amountCents: 30000, period: "monthly" }, maxVolume: null, replacesCeilings: replaces });
      expect(monthly.status).toBe(200);
      expect(await db.select().from(campaignDailyBudgets)).toHaveLength(0);
    });

    it("converts the prod shape of brand a179bbd9: its only ceiling has no offer (a sourcing split on it)", async () => {
      mockUpstreams();
      await db.insert(campaignDailyBudgets).values({
        orgId, brandId, featureSlug: COLD, offerId: null, legKey: "lead_found_to_conversation",
        dailyBudgetCents: "800", sourcingCeilingCents: "350", updatedAt: new Date(),
      });
      const before = await brandDaily();
      const res = await internalPut({
        maxBudget: { amountCents: "800", period: "daily" },
        maxVolume: null,
        replacesCeilings: [{ featureSlug: COLD, legKey: "lead_found_to_conversation" }],
      });
      expect(res.status).toBe(200);
      expect(res.body.conversion).toMatchObject({ replacedDailyCents: "800.0000000000", capDailyCents: "800.0000000000" });
      expect(res.body.conversion.replacedCeilings).toEqual([
        { featureSlug: COLD, offerId: null, legKey: "lead_found_to_conversation", dailyBudgetCents: "800.0000000000" },
      ]);
      expect(await brandDaily()).toBe(before);
      expect(await db.select().from(campaignDailyBudgets)).toHaveLength(0);
    });

    it("attributes an offer-less ceiling to the converting offer when it is the ONLY one of its channel and leg, even if the brand names another offer elsewhere", async () => {
      mockUpstreams();
      await ceiling(COLD, "lead_found_to_conversation", "800", null);
      // Another offer named on ANOTHER channel: the shared read resolver no longer attributes the row.
      await ceiling(BOOKING, "conversation_to_meeting_booked", "300", OTHER_OFFER);
      const res = await internalPut({
        maxBudget: { amountCents: "800", period: "daily" },
        maxVolume: null,
        replacesCeilings: [{ featureSlug: COLD, legKey: "start_to_conversation" }],
      });
      expect(res.status).toBe(200);
      const left = await db.select().from(campaignDailyBudgets);
      expect(left.map((r) => [r.featureSlug, r.offerId])).toEqual([[BOOKING, OTHER_OFFER]]);
    });

    it("refuses an offer-less ceiling when another ceiling funds the same channel and leg (ambiguous), nothing written", async () => {
      mockUpstreams();
      await ceiling(COLD, "lead_found_to_conversation", "800", null);
      await ceiling(COLD, "lead_found_to_conversation", "900", OTHER_OFFER);
      const res = await internalPut({
        maxBudget: { amountCents: "800", period: "daily" },
        maxVolume: null,
        replacesCeilings: [{ featureSlug: COLD, legKey: "lead_found_to_conversation" }],
      });
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("ceiling_ambiguous");
      expect(await db.select().from(campaignDailyBudgets)).toHaveLength(2);
      expect(await db.select().from(salesFunnelCaps)).toHaveLength(0);
    });

    it("refuses a subscriber org and a brand on a global sales budget", async () => {
      mockUpstreams();
      await ceiling(COLD, "lead_found_to_conversation", "1000");
      const replaces = [{ featureSlug: COLD, legKey: "lead_found_to_conversation" }];
      await db.insert(brandSalesBudgets).values({ orgId, brandId, dailyBudgetCents: "500" });
      const global = await internalPut({ maxBudget: { amountCents: 1000, period: "daily" }, maxVolume: null, replacesCeilings: replaces });
      expect(global.body.reason).toBe("brand_in_global_mode");
      await db.delete(brandSalesBudgets);
      await insertTestAccount({ orgId, topupAmountCents: null, topupThresholdCents: null, paymentMode: "subscription" });
      const sub = await internalPut({ maxBudget: { amountCents: 1000, period: "daily" }, maxVolume: null, replacesCeilings: replaces });
      expect(sub.body.reason).toBe("subscription_org");
      expect(await db.select().from(campaignDailyBudgets)).toHaveLength(1);
      expect(await db.select().from(salesFunnelCaps)).toHaveLength(0);
    });
  });
});
