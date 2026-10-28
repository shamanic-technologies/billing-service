/**
 * FACTORY-P1-FOLLOW-PLAN (owner 2026-10-28): a funnel campaign FOLLOWING ITS PLAN runs
 * units on pipes its own sales funnel does not list. Its caps (stated under the funnel
 * campaign's own salesFunnelId) still count every one of those units, spend AND volume,
 * and the caps answer names each such pipe's mode. A campaign whose units all sit on its
 * funnel's pipes reads byte-identical figures.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { __resetSalesFunnelCache } from "../../src/lib/sales-funnel-catalogue.js";
import { __primeSalesPathTerms, __resetSalesPathTerms } from "../../src/lib/sales-path-terms.js";

const orgId = "00000000-0000-0000-0000-000000102901";
const userId = "00000000-0000-0000-0000-000000102909";
const runId = "00000000-0000-0000-0000-00000010290a";
const brandId = "00000000-0000-0000-0000-000000102911";
const OFFER = "aaaaaaaa-1029-4029-8029-aaaaaaaaaaaa";

const COLD = "sales-cold-email-outreach";
const FEEDBACK = "feedback-request-cold-email-outreach";
const MEETING = "ai-meeting-booking";
const FOLLOW_UP = "ai-follow-up-email";
const TEAM = "your-team-closing-calls";

const PROACTIVE_FUNNEL = "start_to_conversation@sales-cold-email-outreach+conversation_to_paid_client";
const REACTIVE_FUNNEL = "signup_to_paid_client@ai-follow-up-email";

const U_COLD = "33333333-0000-4000-8000-000000000001";
const U_FEEDBACK = "33333333-0000-4000-8000-000000000002";
const U_MEETING = "33333333-0000-4000-8000-000000000003";
const U_TEAM = "33333333-0000-4000-8000-000000000004";
const U_UNKNOWN = "33333333-0000-4000-8000-000000000005";
const U_SIGNUP = "33333333-0000-4000-8000-000000000011";
const U_VISIT = "33333333-0000-4000-8000-000000000012";
const U_AFTER_PAID = "33333333-0000-4000-8000-000000000013";

const app = createTestApp();
const auth = getAuthHeaders(orgId, userId, runId);
const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const capsPath = (funnel: string) =>
  `/brands/${brandId}/offers/${OFFER}/sales-funnels/${encodeURIComponent(funnel)}/caps`;

const funnelDetail = (id: string) =>
  id === PROACTIVE_FUNNEL
    ? {
        object: "sales_funnel",
        id,
        name: "Victory",
        type: "proactive",
        legs: [
          {
            legKey: "start_to_conversation",
            toStep: "conversation",
            pipe: { id: `${COLD}|start_to_conversation`, mode: "proactive" },
          },
          { legKey: "conversation_to_paid_client", toStep: "paid_client", pipe: null },
        ],
      }
    : id === REACTIVE_FUNNEL
      ? {
          object: "sales_funnel",
          id,
          name: "Nudge",
          type: "reactive",
          trigger: { slug: "follow_up_due" },
          legs: [
            {
              legKey: "signup_to_paid_client",
              toStep: "paid_client",
              pipe: { id: `${FOLLOW_UP}|signup_to_paid_client`, mode: "reactive" },
            },
          ],
        }
      : null;

// features-service /public/channels, the legs a followed plan may add.
const CHANNELS = [
  {
    slug: COLD,
    managed: true,
    stepTransitions: [{ legKey: "start_to_conversation", from: null, to: { key: "conversation" }, reactive: false }],
  },
  {
    slug: FEEDBACK,
    managed: true,
    stepTransitions: [{ legKey: "start_to_conversation", from: null, to: { key: "conversation" }, reactive: false }],
  },
  {
    slug: MEETING,
    managed: true,
    stepTransitions: [
      { legKey: "conversation_to_meeting_booked", from: { key: "conversation" }, to: { key: "meeting_booked" }, reactive: true },
    ],
  },
  {
    slug: FOLLOW_UP,
    managed: true,
    stepTransitions: [
      { legKey: "signup_to_paid_client", from: { key: "signup" }, to: { key: "paid_client" }, reactive: true },
      { legKey: "website_visit_to_paid_client", from: { key: "website_visit" }, to: { key: "paid_client" }, reactive: true },
      { legKey: "paid_client_to_referral", from: { key: "paid_client" }, to: { key: "referral" }, reactive: true },
    ],
  },
  {
    slug: TEAM,
    operatedBy: "customer",
    managed: true,
    stepTransitions: [{ legKey: "meeting_booked_to_paid_client", from: { key: "meeting_booked" }, to: { key: "paid_client" }, reactive: false }],
  },
];

type Unit = { campaignId: string; featureSlug: string; legKey: string; status: string };
const unit = (campaignId: string, featureSlug: string, legKey: string): Unit => ({
  campaignId,
  featureSlug,
  legKey,
  status: "ongoing",
});

function mockUpstreams(fcs: Array<{ id: string; salesFunnelId: string; units: Unit[] }>) {
  const calls = { costs: [] as URLSearchParams[], outcomes: [] as URLSearchParams[], runs: [] as URLSearchParams[] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/internal/catalogue/sales-funnels/")) {
      const body = funnelDetail(decodeURIComponent(url.pathname.split("/").pop()!));
      return body ? Response.json(body) : Response.json({ reason: "sales_funnel_not_found" }, { status: 404 });
    }
    if (url.pathname === "/sales-funnel-campaigns") {
      return Response.json({
        salesFunnelCampaigns: fcs.map((c) => ({ ...c, orgId, brandId, offerId: OFFER, status: "ongoing" })),
      });
    }
    if (url.pathname === "/internal/campaigns/recurring-status") {
      return Response.json({
        campaigns: fcs.flatMap((c) =>
          c.units.map((u) => ({
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
          }))
        ),
      });
    }
    if (url.pathname === "/v1/stats/costs") {
      calls.costs.push(url.searchParams);
      return Response.json({
        groups: url.searchParams
          .get("campaignIds")!
          .split(",")
          .map((id) => ({ dimensions: { campaignId: id }, totalCostInUsdCents: "999", netTotalCostInUsdCents: "100.5" })),
      });
    }
    if (url.pathname === "/v1/stats/run-outcomes") {
      calls.outcomes.push(url.searchParams);
      return Response.json({
        scope: "all",
        groups: url.searchParams
          .get("campaignIds")!
          .split(",")
          .map((id) => ({ dimensions: { campaignId: id }, runCount: 9, completedCount: 6, failedCount: 1, runningCount: 2 })),
      });
    }
    if (url.pathname === "/v1/runs") {
      calls.runs.push(url.searchParams);
      return Response.json({ runs: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

const put = (funnel: string, body: unknown) =>
  request(app).put(`/v1${capsPath(funnel)}`).set(auth).send(body as object);
const read = (funnel: string) => request(app).get(`/internal${capsPath(funnel)}`).set(internal);
const BOTH = { maxBudget: { amountCents: "5000", period: "daily" }, maxVolume: { count: 100, period: "daily" } };

describe("sales funnel caps: a funnel campaign following its plan", () => {
  const savedEnv = { ...process.env };
  beforeAll(() => {
    process.env.FEATURES_SERVICE_API_KEY = "test-features-key";
    process.env.CAMPAIGN_SERVICE_URL = "http://localhost:9994";
    process.env.CAMPAIGN_SERVICE_API_KEY = "test-campaign-key";
  });
  beforeEach(async () => {
    await cleanTestData();
    __resetSalesFunnelCache();
    __primeSalesPathTerms(CHANNELS as never, { sourceLegKey: "start_to_lead_found", origins: [], originsByChannel: {} } as never);
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

  it("today's shape (every unit on its funnel's pipes): figures and pipes unchanged", async () => {
    const calls = mockUpstreams([{ id: "fc-1", salesFunnelId: PROACTIVE_FUNNEL, units: [unit(U_COLD, COLD, "start_to_conversation")] }]);
    expect((await put(PROACTIVE_FUNNEL, BOTH)).status).toBe(200);
    const res = await read(PROACTIVE_FUNNEL);
    expect(res.status).toBe(200);
    expect(res.body.maxBudget).toMatchObject({ consumedCents: "100.5000000000", reached: false, consumedUnavailableReason: null });
    expect(res.body.maxVolume).toMatchObject({ unit: "first_contacts", consumed: 8, reached: false });
    expect(res.body.volumeUnit).toBe("first_contacts");
    expect(res.body.pipes).toEqual([
      {
        pipeId: `${COLD}|start_to_conversation`,
        channelSlug: COLD,
        legKey: "start_to_conversation",
        strategyId: null,
        mode: "proactive",
        toStep: "conversation",
        campaignIds: [U_COLD],
      },
    ]);
    expect(calls.costs[0]!.get("campaignIds")).toBe(U_COLD);
    expect(calls.outcomes[0]!.get("campaignIds")).toBe(U_COLD);
  });

  it("a unit on a pipe its funnel does not list: its spend and first contacts count, its mode is served", async () => {
    const calls = mockUpstreams([
      {
        id: "fc-1",
        salesFunnelId: PROACTIVE_FUNNEL,
        units: [
          unit(U_COLD, COLD, "start_to_conversation"),
          unit(U_FEEDBACK, FEEDBACK, "start_to_conversation"),
          unit(U_MEETING, MEETING, "conversation_to_meeting_booked"),
          unit(U_TEAM, TEAM, "meeting_booked_to_paid_client"),
        ],
      },
    ]);
    await put(PROACTIVE_FUNNEL, BOTH);
    const res = await read(PROACTIVE_FUNNEL);
    expect(res.status).toBe(200);
    // Spend: every unit of the campaign, the plan's pipes included (4 x 100.5).
    expect(calls.costs[0]!.get("campaignIds")!.split(",").sort()).toEqual([U_COLD, U_FEEDBACK, U_MEETING, U_TEAM].sort());
    expect(res.body.maxBudget).toMatchObject({ consumedCents: "402.0000000000", consumedUnavailableReason: null });
    // Volume: first contacts of BOTH proactive pipes we run (2 x 8); the reactive pipe takes
    // on prospects already contacted, the customer's team pipe is theirs.
    expect(calls.outcomes[0]!.get("campaignIds")!.split(",").sort()).toEqual([U_COLD, U_FEEDBACK].sort());
    expect(res.body.maxVolume).toMatchObject({ unit: "first_contacts", consumed: 16, reached: false, consumedUnavailableReason: null });
    const byId = Object.fromEntries((res.body.pipes as Array<{ pipeId: string }>).map((p) => [p.pipeId, p]));
    expect(byId[`${FEEDBACK}|start_to_conversation`]).toMatchObject({ mode: "proactive", outsideFunnel: true, campaignIds: [U_FEEDBACK] });
    expect(byId[`${MEETING}|conversation_to_meeting_booked`]).toMatchObject({
      mode: "reactive",
      outsideFunnel: true,
      fromStep: "conversation",
      campaignIds: [U_MEETING],
    });
    expect(byId[`${TEAM}|meeting_booked_to_paid_client`]).toMatchObject({ mode: "proactive", runByUs: false, campaignIds: [U_TEAM] });
    // The funnel's own pipe carries no new field.
    expect(byId[`${COLD}|start_to_conversation`]).not.toHaveProperty("outsideFunnel");
  });

  it("a reactive funnel: a plan pipe taking prospects on itself is counted, one downstream of a counted pipe is not", async () => {
    const calls = mockUpstreams([
      {
        id: "fc-2",
        salesFunnelId: REACTIVE_FUNNEL,
        units: [
          unit(U_SIGNUP, FOLLOW_UP, "signup_to_paid_client"),
          unit(U_VISIT, FOLLOW_UP, "website_visit_to_paid_client"),
          unit(U_AFTER_PAID, FOLLOW_UP, "paid_client_to_referral"),
        ],
      },
    ]);
    await put(REACTIVE_FUNNEL, BOTH);
    const res = await read(REACTIVE_FUNNEL);
    expect(res.status).toBe(200);
    expect(res.body.maxBudget).toMatchObject({ consumedCents: "301.5000000000" });
    expect(res.body.volumeUnit).toBe("prospects_handled");
    expect(calls.outcomes[0]!.get("campaignIds")!.split(",").sort()).toEqual([U_SIGNUP, U_VISIT].sort());
    expect(res.body.maxVolume).toMatchObject({ unit: "prospects_handled", consumed: 16, consumedUnavailableReason: null });
    const visit = (res.body.pipes as Array<{ pipeId: string }>).find((p) => p.pipeId === `${FOLLOW_UP}|website_visit_to_paid_client`);
    expect(visit).toMatchObject({ mode: "reactive", outsideFunnel: true, fromStep: "website_visit" });
  });

  it("a plan pipe the channel catalogue does not publish: unreadable, never uncounted", async () => {
    mockUpstreams([
      {
        id: "fc-1",
        salesFunnelId: PROACTIVE_FUNNEL,
        units: [unit(U_COLD, COLD, "start_to_conversation"), unit(U_UNKNOWN, "mystery-channel", "start_to_conversation")],
      },
    ]);
    await put(PROACTIVE_FUNNEL, BOTH);
    const res = await read(PROACTIVE_FUNNEL);
    expect(res.status).toBe(200);
    expect(res.body.maxBudget).toMatchObject({ consumedCents: null, reached: null, consumedUnavailableReason: "sales_funnel_catalogue_unavailable" });
    expect(res.body.maxVolume).toMatchObject({ consumed: null, reached: null, consumedUnavailableReason: "sales_funnel_catalogue_unavailable" });
  });
});
