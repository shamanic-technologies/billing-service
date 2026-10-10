/**
 * MAX BUDGET + MAX VOLUME per brand x offer x SALES FUNNEL (migration 0078,
 * lib/sales-funnel-caps.ts): stated, read back with what the funnel consumed in
 * the current period, cleared, and never touching the per-campaign ceilings.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaignDailyBudgets, salesFunnelCapChanges, salesFunnelCaps } from "../../src/db/schema.js";
import { __resetSalesFunnelCache } from "../../src/lib/sales-funnel-catalogue.js";

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

const CAMPAIGN_COLD = "11111111-0000-4000-8000-000000000001";
const CAMPAIGN_COLD_LEGACY = "11111111-0000-4000-8000-000000000002";
const CAMPAIGN_BOOKING = "11111111-0000-4000-8000-000000000003";
const CAMPAIGN_OTHER_OFFER = "11111111-0000-4000-8000-000000000004";
const CAMPAIGN_OTHER_LEG = "11111111-0000-4000-8000-000000000005";

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
  features: number;
  campaigns: number;
}

function mockUpstreams(opts: { featuresStatus?: number; runsStatus?: number } = {}): Calls {
  const calls: Calls = { costs: [], outcomes: [], features: 0, campaigns: 0 };
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
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    for (const k of ["FEATURES_SERVICE_API_KEY", "CAMPAIGN_SERVICE_URL", "CAMPAIGN_SERVICE_API_KEY"]) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await cleanTestData();
    await closeDb();
  });

  it("nothing stated: stated false, both caps null, no upstream read", async () => {
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
      salesFunnelName: null,
      pipes: null,
    });
    expect(calls.features + calls.campaigns + calls.costs.length + calls.outcomes.length).toBe(0);
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

    // Spend: every campaign of the funnel's pipes for this brand x offer (both
    // spellings of the cold leg + the booking campaign), never another offer or leg.
    const spendIds = calls.costs.at(-1)!.get("campaignIds")!.split(",").sort();
    expect(spendIds).toEqual([CAMPAIGN_COLD, CAMPAIGN_COLD_LEGACY, CAMPAIGN_BOOKING].sort());
    expect(b.maxBudget).toMatchObject({
      amountCents: "5000.0000000000",
      period: "weekly",
      consumedCents: "3001.5000000000",
      remainingCents: "1998.5000000000",
      reached: false,
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
        maxBudget: null,
        maxVolume: { count: 3, period: "daily", unit: "first_contacts" },
        updatedAt: expect.any(String),
      },
    ]);
    const none = await request(app).get(`/internal/brands/${brandId}/sales-funnel-caps`).set(internal(otherOrgId));
    expect(none.body.caps).toEqual([]);
  });

  it("the per-campaign ceilings and the brand daily budget read exactly as before", async () => {
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
    const before = await request(app).get(`/internal/brands/${brandId}/daily-budget`).set(internal(orgId));
    await put({ maxBudget: { amountCents: 100, period: "daily" }, maxVolume: { count: 1, period: "daily" } });
    const after = await request(app).get(`/internal/brands/${brandId}/daily-budget`).set(internal(orgId));
    expect(after.body.dailyBudgetCents).toBe("700.0000000000");
    expect(after.body).toEqual(before.body);
  });
});
