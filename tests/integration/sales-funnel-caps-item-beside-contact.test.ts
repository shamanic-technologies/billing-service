/**
 * THREADS-POSTS-CAP-1124: a funnel campaign on a Threads funnel (an ITEM pipe: a post contacts
 * nobody) followed its plan onto Apollo sourcing + cold email. Its only cap, 1 a day, counts
 * first contacts; the Threads pipe has no first-contact measure, and the whole volume read
 * `volume_not_measured_on_channel`, so nothing stopped the plan's sourcing. The first contacts
 * are the cold email's: the item pipe and the lead source are left out of the count.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { __resetSalesFunnelCache } from "../../src/lib/sales-funnel-catalogue.js";
import { __primeSalesPathTerms, __resetSalesPathTerms } from "../../src/lib/sales-path-terms.js";

const orgId = "00000000-0000-4000-8000-000000112401";
const userId = "00000000-0000-4000-8000-000000112409";
const runId = "00000000-0000-4000-8000-00000011240a";
const brandId = "00000000-0000-4000-8000-000000112411";
const OFFER = "aaaaaaaa-1124-4024-8024-aaaaaaaaaaaa";
const FC = "44444444-1124-4024-8024-000000000001";

const THREADS = "threads-post";
const TEAM = "your-team-closing-calls";
const COLD = "sales-cold-email-outreach";
const APOLLO = "sourcing-apollo-cold-filters";
const FUNNEL = "start_to_threads_post_published@threads-post+threads_post_published_to_paid_client";

const U_THREADS = "33333333-1124-4000-8000-000000000001";
const U_TEAM = "33333333-1124-4000-8000-000000000002";
const U_COLD = "33333333-1124-4000-8000-000000000003";
const U_APOLLO = "33333333-1124-4000-8000-000000000004";

const app = createTestApp();
const auth = getAuthHeaders(orgId, userId, runId);
const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const capsPath = `/brands/${brandId}/offers/${OFFER}/sales-funnels/${encodeURIComponent(FUNNEL)}/campaigns/${FC}/caps`;

const DETAIL = {
  object: "sales_funnel",
  id: FUNNEL,
  name: "Threads Posts",
  type: "proactive",
  legs: [
    {
      legKey: "start_to_threads_post_published",
      toStep: "threads_post_published",
      channels: [{ id: THREADS, name: "Threads posts", runByUs: true }],
      pipe: { id: `${THREADS}|start_to_threads_post_published`, mode: "proactive" },
    },
    {
      legKey: "threads_post_published_to_paid_client",
      toStep: "paid_client",
      channels: [{ id: TEAM, name: "Your Team Closing Calls", runByUs: false }],
      pipe: { id: `${TEAM}|threads_post_published_to_paid_client`, mode: "proactive" },
    },
  ],
};

const CHANNELS = [
  {
    slug: COLD,
    managed: true,
    stepTransitions: [{ legKey: "lead_found_to_website_visit", from: { key: "lead_found" }, to: { key: "website_visit" }, reactive: false }],
  },
  {
    slug: APOLLO,
    managed: true,
    stepTransitions: [{ legKey: "start_to_lead_found", from: null, to: { key: "lead_found" }, reactive: false }],
  },
];

type Unit = { campaignId: string; featureSlug: string; legKey: string; status: string };
const unit = (campaignId: string, featureSlug: string, legKey: string): Unit => ({ campaignId, featureSlug, legKey, status: "ongoing" });

function mockUpstreams(units: Unit[], firstEmails: number) {
  const calls = { outcomes: [] as URLSearchParams[] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/internal/catalogue/sales-funnels/")) return Response.json(DETAIL);
    if (url.pathname === "/sales-funnel-campaigns") {
      return Response.json({
        salesFunnelCampaigns: [{ id: FC, salesFunnelId: FUNNEL, units, orgId, brandId, offerId: OFFER, status: "ongoing" }],
      });
    }
    if (url.pathname === "/internal/campaigns/recurring-status") {
      return Response.json({
        campaigns: units.map((u) => ({
          campaignId: u.campaignId,
          orgId,
          brandId,
          offerId: OFFER,
          featureSlug: u.featureSlug,
          legKey: u.legKey,
          status: "ongoing",
          running: true,
          executedByPlatform: true,
          kind: "proactive",
          audience: "available",
          allAudiencesExhausted: false,
          recurring: true,
        })),
      });
    }
    if (url.pathname === "/v1/stats/costs") {
      return Response.json({
        groups: url.searchParams.get("campaignIds")!.split(",").map((id) => ({
          dimensions: { campaignId: id },
          totalCostInUsdCents: "0",
          netTotalCostInUsdCents: "0",
        })),
      });
    }
    if (url.pathname === "/v1/stats/run-outcomes") {
      calls.outcomes.push(url.searchParams);
      return Response.json({
        scope: "all",
        groups: url.searchParams.get("campaignIds")!.split(",").map((id) => ({
          dimensions: { campaignId: id },
          runCount: firstEmails,
          completedCount: firstEmails,
          failedCount: 0,
          runningCount: 0,
        })),
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

// A max volume is never stated alone since 2026-11-24 (VOL-NEEDS-USD-1124): the max budget
// beside it is far above anything spent here, so only the 1-a-day volume binds.
const ONE_A_DAY = { maxBudget: { amountCents: 500000, period: "daily" }, maxVolume: { count: 1, period: "daily" } };

describe("sales funnel caps: an item pipe beside a plan pipe that reaches people", () => {
  const savedEnv = { ...process.env };
  beforeAll(() => {
    process.env.FEATURES_SERVICE_API_KEY = "test-features-key";
    process.env.CAMPAIGN_SERVICE_URL = "http://localhost:9994";
    process.env.CAMPAIGN_SERVICE_API_KEY = "test-campaign-key";
  });
  beforeEach(async () => {
    await cleanTestData();
    __resetSalesFunnelCache();
    __primeSalesPathTerms(CHANNELS as never, {
      sourceLegKey: "start_to_lead_found",
      origins: [{ slug: APOLLO }],
      originsByChannel: { [COLD]: [APOLLO] },
    } as never);
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

  it("counts the cold email's first contacts and reads the 1-a-day cap reached", async () => {
    const calls = mockUpstreams(
      [
        unit(U_THREADS, THREADS, "start_to_threads_post_published"),
        unit(U_TEAM, TEAM, "threads_post_published_to_paid_client"),
        unit(U_COLD, COLD, "lead_found_to_website_visit"),
        unit(U_APOLLO, APOLLO, "start_to_lead_found"),
      ],
      1
    );
    expect((await request(app).put(`/v1${capsPath}`).set(auth).send(ONE_A_DAY)).status).toBe(200);
    const res = await request(app).get(`/internal${capsPath}`).set(internal);
    expect(res.status).toBe(200);
    expect(res.body.maxVolume).toMatchObject({
      unit: "first_contacts",
      consumed: 1,
      remaining: 0,
      reached: true,
      consumedUnavailableReason: null,
    });
    // Only the cold email unit is asked for first contacts: never the Threads post, the source or the team.
    expect(new Set(calls.outcomes.map((p) => p.get("campaignIds")))).toEqual(new Set([U_COLD]));
  });

  it("the Threads pipe alone still counts its posts (unchanged shape)", async () => {
    mockUpstreams(
      [unit(U_THREADS, THREADS, "start_to_threads_post_published"), unit(U_TEAM, TEAM, "threads_post_published_to_paid_client")],
      0
    );
    await request(app).put(`/v1${capsPath}`).set(auth).send(ONE_A_DAY);
    const res = await request(app).get(`/internal${capsPath}`).set(internal);
    expect(res.status).toBe(200);
    expect(res.body.maxVolume.unit).toBe("outcomes_produced");
  });
});
