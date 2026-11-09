/**
 * MIGRATE-1105 S8: a campaign launched on its TARGET alone (campaign-service #883) has no sales
 * funnel: its funnel id IS its target (`backlink_earned`), it owns ONE unit with no channel and no
 * leg, born on that outcome's Engine (`engine:backlink_earned`). features-service knows no funnel
 * of that id (404), so billing caps it on the campaign's own shape: one proactive pipe from Start
 * making the target, its spend and its produced outcomes measured on the unit.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { __resetSalesFunnelCache } from "../../src/lib/sales-funnel-catalogue.js";
import { __primeSalesPathTerms, __resetSalesPathTerms } from "../../src/lib/sales-path-terms.js";
import { __resetStepEvidence } from "../../src/lib/sales-funnel-caps.js";

const orgId = "00000000-0000-0000-0000-000000110501";
const userId = "00000000-0000-0000-0000-000000110509";
const runId = "00000000-0000-0000-0000-00000011050a";
const brandId = "00000000-0000-0000-0000-000000110511";
const OFFER = "aaaaaaaa-1105-4105-8105-aaaaaaaaaaaa";

const TARGET = "backlink_earned";
const FC = "33333333-0000-4000-8000-000000000001";
const UNIT = "33333333-0000-4000-8000-000000000002";
const OTHER = "33333333-0000-4000-8000-000000000003";

const app = createTestApp();
const auth = getAuthHeaders(orgId, userId, runId);
const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const capsPath = (funnel: string) => `/brands/${brandId}/offers/${OFFER}/sales-funnels/${encodeURIComponent(funnel)}/caps`;

const occurrence = (campaignId: string | null) => ({
  id: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  direction: "produced",
  outcomeKey: TARGET,
  quantity: "1.000000",
  tags: { brandIds: [brandId], campaignId, workflowSlug: null, featureSlug: null, audienceId: null },
});

function mockUpstreams(opts: { spentCents?: string; earned?: number; featuresStatus?: number } = {}) {
  const calls = { costs: [] as URLSearchParams[], occurrences: [] as URLSearchParams[], features: 0 };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/internal/catalogue/sales-funnels/")) {
      calls.features += 1;
      // features-service knows no funnel named after a step key.
      return Response.json({ reason: "sales_funnel_not_found" }, { status: opts.featuresStatus ?? 404 });
    }
    if (url.pathname === "/sales-funnel-campaigns") {
      return Response.json({
        salesFunnelCampaigns: [
          {
            id: FC,
            orgId,
            brandId,
            offerId: OFFER,
            salesFunnelId: TARGET,
            salesFunnelName: null,
            name: "Backlinks for Acme",
            target: TARGET,
            status: "ongoing",
            units: [
              {
                campaignId: UNIT,
                pipeId: null,
                featureSlug: null,
                legKey: null,
                status: "ongoing",
                workflowSlug: `engine:${TARGET}`,
                name: "Backlinks for Acme",
                salesFunnelId: TARGET,
                planRole: null,
                runsOnTriggerId: null,
              },
            ],
          },
        ],
      });
    }
    if (url.pathname === "/internal/campaigns/recurring-status") {
      return Response.json({
        campaigns: [
          {
            campaignId: UNIT,
            orgId,
            brandId,
            offerId: OFFER,
            featureSlug: null,
            legKey: null,
            status: "ongoing",
            running: true,
            executedByPlatform: true,
            kind: "proactive",
            audience: "available",
            allAudiencesExhausted: false,
            recurring: true,
          },
        ],
      });
    }
    if (url.pathname === "/v1/stats/costs") {
      calls.costs.push(url.searchParams);
      return Response.json({
        groups: url.searchParams
          .get("campaignIds")!
          .split(",")
          .map((id) => ({ dimensions: { campaignId: id }, netTotalCostInUsdCents: id === UNIT ? (opts.spentCents ?? "0") : "999" })),
      });
    }
    if (url.pathname === "/internal/outcome-occurrences") {
      if (!url.searchParams.get("orgId")) {
        return Response.json({ occurrences: [occurrence(OTHER)], nextCursor: null });
      }
      calls.occurrences.push(url.searchParams);
      return Response.json({
        occurrences: [...Array.from({ length: opts.earned ?? 0 }, () => occurrence(UNIT)), occurrence(OTHER)],
        nextCursor: null,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

const put = (funnel: string, body: unknown) => request(app).put(`/v1${capsPath(funnel)}`).set(auth).send(body as object);
const read = (funnel: string) => request(app).get(`/internal${capsPath(funnel)}`).set(internal);

describe("sales funnel caps: a campaign launched on its target alone", () => {
  const savedEnv = { ...process.env };
  beforeAll(() => {
    process.env.FEATURES_SERVICE_API_KEY = "test-features-key";
    process.env.CAMPAIGN_SERVICE_URL = "http://localhost:9994";
    process.env.CAMPAIGN_SERVICE_API_KEY = "test-campaign-key";
  });
  beforeEach(async () => {
    await cleanTestData();
    __resetSalesFunnelCache();
    __resetStepEvidence();
    __primeSalesPathTerms([], { sourceLegKey: "start_to_lead_found", origins: [], originsByChannel: {} } as never);
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

  it("$5/day: the PUT is accepted, funded, and its spend is measured on the campaign's one unit", async () => {
    const calls = mockUpstreams({ spentCents: "120" });
    const res = await put(TARGET, { maxBudget: { amountCents: 500, period: "daily" }, maxVolume: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stated: true, funded: true, fundedBy: "max_budget", salesFunnelType: "proactive" });

    const featuresBeforeRead = calls.features;
    const r = await read(TARGET);
    expect(r.status).toBe(200);
    expect(r.body.funded).toBe(true);
    expect(r.body.maxBudget).toMatchObject({
      period: "daily",
      consumedCents: "120.0000000000",
      reached: false,
      consumedUnavailableReason: null,
    });
    expect(r.body.pipes).toHaveLength(1);
    expect(r.body.pipes[0]).toMatchObject({ mode: "proactive", toStep: TARGET, campaignIds: [UNIT] });
    // Only the unit's spend: never another campaign's.
    expect(calls.costs.at(-1)!.get("campaignIds")).toBe(UNIT);
    // The read recognises it on campaign-service's own shape: features-service is not asked again.
    expect(calls.features).toBe(featuresBeforeRead);
  });

  it("the target-only campaign is capped even while features-service is down", async () => {
    mockUpstreams({ featuresStatus: 503 });
    const res = await put(TARGET, { maxBudget: { amountCents: 500, period: "daily" }, maxVolume: null });
    expect(res.status).toBe(200);
    expect((await read(TARGET)).body.maxBudget.consumedUnavailableReason).toBeNull();
  });

  it("a max volume counts the target outcomes the unit produced", async () => {
    const calls = mockUpstreams({ earned: 2 });
    expect((await put(TARGET, { maxBudget: null, maxVolume: { count: 3, period: "daily" } })).status).toBe(200);
    const r = await read(TARGET);
    expect(r.body.volumeUnit).toBe("outcomes_produced");
    expect(r.body.maxVolume).toMatchObject({ unit: "outcomes_produced", consumed: 2, remaining: 1, reached: false });
    expect(calls.occurrences[0]!.get("outcomeKey")).toBe(TARGET);
  });

  it("the brand list types it proactive", async () => {
    mockUpstreams();
    await put(TARGET, { maxBudget: { amountCents: 500, period: "daily" }, maxVolume: null });
    const r = await request(app).get(`/internal/brands/${brandId}/sales-funnel-caps`).set(internal);
    expect(r.status).toBe(200);
    expect(r.body.caps[0]).toMatchObject({ salesFunnelId: TARGET, salesFunnelType: "proactive", salesFunnelTypeUnavailableReason: null });
  });

  it("an id no funnel and no target-only campaign carries stays 404", async () => {
    mockUpstreams();
    const res = await put("industry_news_found", { maxBudget: { amountCents: 500, period: "daily" }, maxVolume: null });
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("sales_funnel_not_found");
  });
});
