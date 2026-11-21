/**
 * THREADS-CAMPAIGN-1028: a funnel whose proactive pipe starts at Start and makes its own
 * item (a Threads post) counts its max volume as the produced OUTCOMES of its leg's step
 * (`post_published`) declared on runs-service's ledger on its campaign's runs.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { __resetSalesFunnelCache } from "../../src/lib/sales-funnel-catalogue.js";
import { __primeSalesPathTerms, __resetSalesPathTerms } from "../../src/lib/sales-path-terms.js";
import { __resetStepEvidence } from "../../src/lib/sales-funnel-caps.js";

const orgId = "00000000-0000-4000-8000-000000102801";
const userId = "00000000-0000-4000-8000-000000102809";
const runId = "00000000-0000-4000-8000-00000010280a";
const brandId = "00000000-0000-4000-8000-000000102811";
const OFFER = "aaaaaaaa-1028-4028-8028-aaaaaaaaaaaa";

const THREADS = "threads-post";
const TEAM = "your-team-closing-calls";
const THREADS_FUNNEL = "start_to_post_published@threads-post+post_published_to_paid_client";
// A proactive Start pipe whose step no producer is verified to declare on the unit: fail-closed.
const UNDECLARED_FUNNEL = "start_to_website_visit@google-ads+website_visit_to_paid_client";
const CAMPAIGN_THREADS = "22222222-0000-4000-8000-000000000001";
const CAMPAIGN_TEAM = "22222222-0000-4000-8000-000000000002";
const CAMPAIGN_OTHER = "22222222-0000-4000-8000-000000000003";
const CAMPAIGN_ADS = "22222222-0000-4000-8000-000000000004";
// An outcome nobody ever made yet (DISTRY-CALL-IS-CAMPAIGN-1121): measured 0, never held.
const NEWSLETTER = "newsletter-engine";
const NEW_FUNNEL = "start_to_newsletter_drafted@newsletter-engine";
const CAMPAIGN_NEW = "22222222-0000-4000-8000-000000000005";

const app = createTestApp();
const auth = getAuthHeaders(orgId, userId, runId);
const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const capsPath = (funnel: string) =>
  `/brands/${brandId}/offers/${OFFER}/sales-funnels/${encodeURIComponent(funnel)}/caps`;

const funnelDetail = (id: string) =>
  id === THREADS_FUNNEL
    ? {
        object: "sales_funnel",
        id,
        name: "Daily Threads",
        type: "proactive",
        legs: [
          // The live shape (prod 2026-10-28): the customer's own team leg is served PROACTIVE,
          // run by them (`runByUs: false`): never counted, never blocking the measure.
          {
            legKey: "start_to_post_published",
            toStep: "post_published",
            channels: [{ id: THREADS, name: "Threads posts", runByUs: true }],
            pipe: { id: `${THREADS}|start_to_post_published`, mode: "proactive" },
          },
          {
            legKey: "post_published_to_paid_client",
            toStep: "paid_client",
            channels: [{ id: TEAM, name: "Your Team Closing Calls", runByUs: false }],
            pipe: { id: `${TEAM}|post_published_to_paid_client`, mode: "proactive" },
          },
        ],
      }
    : id === UNDECLARED_FUNNEL
      ? {
          object: "sales_funnel",
          id,
          name: "Mirage",
          type: "proactive",
          legs: [
            {
              legKey: "start_to_website_visit",
              toStep: "website_visit",
              pipe: { id: "google-ads|start_to_website_visit", mode: "proactive" },
            },
            { legKey: "website_visit_to_paid_client", toStep: "paid_client", pipe: null },
          ],
        }
      : id === NEW_FUNNEL
        ? {
            object: "sales_funnel",
            id,
            name: "Newsletter",
            type: "proactive",
            legs: [
              {
                legKey: "start_to_newsletter_drafted",
                toStep: "newsletter_drafted",
                channels: [{ id: NEWSLETTER, name: "Newsletter", runByUs: true }],
                pipe: { id: `${NEWSLETTER}|start_to_newsletter_drafted`, mode: "proactive" },
              },
            ],
          }
        : null;

const campaign = (id: string, featureSlug: string, legKey: string) => ({
  campaignId: id,
  orgId,
  brandId,
  offerId: OFFER,
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

const occurrence = (campaignId: string | null, quantity = "1.000000", outcomeKey = "post_published") => ({
  id: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  direction: "produced",
  outcomeKey,
  quantity,
  tags: { brandIds: [brandId], campaignId, workflowSlug: null, featureSlug: null, audienceId: null },
});

function mockUpstreams(opts: { published: number; runsStatus?: number; drafted?: number }) {
  const calls: { occurrences: URLSearchParams[]; evidence: URLSearchParams[]; runOutcomes: number } = {
    occurrences: [],
    evidence: [],
    runOutcomes: 0,
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/internal/catalogue/sales-funnels/")) {
      const body = funnelDetail(decodeURIComponent(url.pathname.split("/").pop()!));
      return body ? Response.json(body) : Response.json({ reason: "sales_funnel_not_found" }, { status: 404 });
    }
    if (url.pathname === "/sales-funnel-campaigns") {
      return Response.json({
        salesFunnelCampaigns: [
          {
            id: "fc-threads",
            orgId,
            brandId,
            offerId: OFFER,
            salesFunnelId: THREADS_FUNNEL,
            status: "ongoing",
            units: [
              { campaignId: CAMPAIGN_THREADS, featureSlug: THREADS, legKey: "start_to_post_published", status: "ongoing" },
              { campaignId: CAMPAIGN_TEAM, featureSlug: TEAM, legKey: "post_published_to_paid_client", status: "ongoing" },
            ],
          },
          {
            id: "fc-ads",
            orgId,
            brandId,
            offerId: OFFER,
            salesFunnelId: UNDECLARED_FUNNEL,
            status: "ongoing",
            units: [{ campaignId: CAMPAIGN_ADS, featureSlug: "google-ads", legKey: "start_to_website_visit", status: "ongoing" }],
          },
          {
            id: "fc-new",
            orgId,
            brandId,
            offerId: OFFER,
            salesFunnelId: NEW_FUNNEL,
            status: "ongoing",
            units: [{ campaignId: CAMPAIGN_NEW, featureSlug: NEWSLETTER, legKey: "start_to_newsletter_drafted", status: "ongoing" }],
          },
        ],
      });
    }
    if (url.pathname === "/internal/campaigns/recurring-status") {
      return Response.json({
        campaigns: [
          campaign(CAMPAIGN_THREADS, THREADS, "start_to_post_published"),
          campaign(CAMPAIGN_TEAM, TEAM, "post_published_to_paid_client"),
          campaign(CAMPAIGN_ADS, "google-ads", "start_to_website_visit"),
          campaign(CAMPAIGN_NEW, NEWSLETTER, "start_to_newsletter_drafted"),
        ],
      });
    }
    if (url.pathname === "/internal/outcome-occurrences") {
      if (opts.runsStatus) return new Response("down", { status: opts.runsStatus });
      // The evidence read (fleet-wide, no org, no window): has the step's producer ever
      // declared it on a campaign's run? post_published: yes; website_visit: never.
      if (!url.searchParams.get("orgId")) {
        calls.evidence.push(url.searchParams);
        const step = url.searchParams.get("outcomeKey");
        if (step === "newsletter_drafted") {
          // Nothing ever drafted: an EMPTY ledger. After the first Unit: on the unit's run.
          const drafted = Array.from({ length: opts.drafted ?? 0 }, () => occurrence(CAMPAIGN_NEW, "1.000000", "newsletter_drafted"));
          return Response.json({ occurrences: drafted, nextCursor: null });
        }
        return Response.json({
          occurrences: [occurrence(null), ...(step === "post_published" ? [occurrence(CAMPAIGN_OTHER)] : [])],
          nextCursor: null,
        });
      }
      calls.occurrences.push(url.searchParams);
      if (url.searchParams.get("outcomeKey") === "newsletter_drafted") {
        const drafted = Array.from({ length: opts.drafted ?? 0 }, () => occurrence(CAMPAIGN_NEW, "1.000000", "newsletter_drafted"));
        return Response.json({ occurrences: drafted, nextCursor: null });
      }
      // Two pages: this unit's publications, plus another campaign's and an org-less
      // publication (social-service daily comments) that are never this funnel's.
      const mine = Array.from({ length: opts.published }, () => occurrence(CAMPAIGN_THREADS));
      if (!url.searchParams.get("cursor")) {
        return Response.json({
          occurrences: [...mine.slice(0, 2), occurrence(CAMPAIGN_OTHER), occurrence(null)],
          nextCursor: "00000000-0000-4000-8000-0000000000ff",
        });
      }
      return Response.json({ occurrences: mine.slice(2), nextCursor: null });
    }
    if (url.pathname === "/v1/stats/run-outcomes") {
      calls.runOutcomes += 1;
      return Response.json({ scope: "all", groups: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

const put = (funnel: string, body: unknown) =>
  request(app).put(`/v1${capsPath(funnel)}`).set(auth).send(body as object);
const read = (funnel: string) => request(app).get(`/internal${capsPath(funnel)}`).set(internal);

describe("sales funnel caps: outcome pipes (Threads)", () => {
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

  it("5 per day, 3 threads published today on the unit: consumed 3, not reached", async () => {
    const calls = mockUpstreams({ published: 3 });
    expect((await put(THREADS_FUNNEL, { maxBudget: null, maxVolume: { count: 5, period: "daily" } })).status).toBe(200);

    const res = await read(THREADS_FUNNEL);
    expect(res.status).toBe(200);
    expect(res.body.volumeUnit).toBe("outcomes_produced");
    expect(res.body.maxBudget).toBeNull();
    expect(res.body.maxVolume).toMatchObject({
      count: 5,
      period: "daily",
      unit: "outcomes_produced",
      consumed: 3,
      remaining: 2,
      reached: false,
      consumedUnavailableReason: null,
    });
    // Asked as the org, produced post_published since today's UTC midnight, both pages walked.
    const first = calls.occurrences[0]!;
    expect(first.get("orgId")).toBe(orgId);
    expect(first.get("outcomeKey")).toBe("post_published");
    expect(first.get("direction")).toBe("produced");
    expect(first.get("declaredAfter")).toBe(res.body.maxVolume.periodStart);
    expect(new Date(res.body.maxVolume.periodStart).getUTCHours()).toBe(0);
    expect(calls.occurrences[1]!.get("cursor")).toBe("00000000-0000-4000-8000-0000000000ff");
    // Never a run-task count for this pipe.
    expect(calls.runOutcomes).toBe(0);
  });

  it("5 threads published today: reached, remaining 0", async () => {
    mockUpstreams({ published: 5 });
    await put(THREADS_FUNNEL, { maxBudget: null, maxVolume: { count: 5, period: "daily" } });
    const res = await read(THREADS_FUNNEL);
    expect(res.body.maxVolume).toMatchObject({ consumed: 5, remaining: 0, reached: true, consumedUnavailableReason: null });
  });

  it("the ledger unreadable: null + runs_service_unavailable, never 0", async () => {
    mockUpstreams({ published: 5, runsStatus: 503 });
    await put(THREADS_FUNNEL, { maxBudget: null, maxVolume: { count: 5, period: "daily" } });
    const res = await read(THREADS_FUNNEL);
    expect(res.body.maxVolume).toMatchObject({ consumed: null, reached: null, consumedUnavailableReason: "runs_service_unavailable" });
  });

  it("the evidence is read once: the ledger showed the producer declares the step on campaign runs", async () => {
    const calls = mockUpstreams({ published: 1 });
    await put(THREADS_FUNNEL, { maxBudget: null, maxVolume: { count: 5, period: "daily" } });
    await read(THREADS_FUNNEL);
    await read(THREADS_FUNNEL);
    expect(calls.evidence).toHaveLength(1);
    expect(calls.evidence[0]!.get("outcomeKey")).toBe("post_published");
    expect(calls.evidence[0]!.get("direction")).toBe("produced");
  });

  it("a Start pipe whose step no producer ever declared on a campaign's run stays unmeasured (fail-closed)", async () => {
    const calls = mockUpstreams({ published: 5 });
    await put(UNDECLARED_FUNNEL, { maxBudget: null, maxVolume: { count: 5, period: "daily" } });
    const res = await read(UNDECLARED_FUNNEL);
    expect(res.body.volumeUnit).toBe("outcomes_produced");
    expect(res.body.maxVolume).toMatchObject({
      consumed: null,
      reached: null,
      consumedUnavailableReason: "volume_not_measured_on_channel",
      consumedUnavailableDetail: "no website_visit outcome was ever declared on a campaign's run",
    });
    expect(calls.occurrences).toHaveLength(0);
  });

  it("max volume 1 one-off on an outcome never made yet: consumed 0, not reached, funded; reached after one Unit", async () => {
    mockUpstreams({ published: 0, drafted: 0 });
    expect((await put(NEW_FUNNEL, { maxBudget: null, maxVolume: { count: 1, period: "one_off" } })).status).toBe(200);
    const before = await read(NEW_FUNNEL);
    expect(before.status).toBe(200);
    expect(before.body.funded).toBe(true);
    expect(before.body.maxVolume).toMatchObject({
      count: 1,
      unit: "outcomes_produced",
      consumed: 0,
      remaining: 1,
      reached: false,
      consumedUnavailableReason: null,
    });

    vi.restoreAllMocks();
    mockUpstreams({ published: 0, drafted: 1 });
    const after = await read(NEW_FUNNEL);
    expect(after.body.maxVolume).toMatchObject({ consumed: 1, remaining: 0, reached: true, consumedUnavailableReason: null });
  });
});
