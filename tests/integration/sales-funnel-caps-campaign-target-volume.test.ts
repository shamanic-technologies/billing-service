/**
 * ONE-CAMPAIGN-VOLUME-1122: a client launches ONE campaign aimed at Meeting booked and states
 * « 10 meetings booked per week, never more than $260 a week ». Its own cap's max volume counts
 * Units of its TARGET (unit outcomes_produced, outcome meeting_booked), off runs-service's ledger:
 * a meeting declared on a run of its units, or a meeting of a person its units reached first (the
 * meeting's producer declares it on its own run, weeks after the first email). The max budget stays
 * the hard ceiling. A campaign whose target is reached BY its first contact (a follow-up's Paid
 * client) keeps counting what it counted.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { __resetSalesFunnelCache } from "../../src/lib/sales-funnel-catalogue.js";
import { __primeSalesPathTerms, __resetSalesPathTerms } from "../../src/lib/sales-path-terms.js";
import { __primeOutcomeSteps, __resetOutcomeSteps } from "../../src/lib/outcome-steps.js";
import { __resetStepEvidence, targetReachedAfterFirstContact } from "../../src/lib/sales-funnel-caps.js";

const orgId = "00000000-0000-4000-8000-000000112201";
const userId = "00000000-0000-4000-8000-000000112209";
const runId = "00000000-0000-4000-8000-00000011220a";
const brandId = "00000000-0000-4000-8000-000000112211";
const OFFER = "aaaaaaaa-1122-4122-8122-aaaaaaaaaaaa";

const SOURCING = "lead-sourcing";
const COLD = "sales-cold-email-outreach";
const MEETING = "ai-meeting-booking";
const FOLLOW_UP = "ai-follow-up-email";

const MEETING_FUNNEL =
  "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
const FOLLOW_UP_FUNNEL = "signup_to_paid_client@ai-follow-up-email";

const FC = "55555555-0000-4000-8000-000000000001";
const U_SOURCE = "55555555-0000-4000-8000-000000000002";
const U_COLD = "55555555-0000-4000-8000-000000000003";
const U_MEETING = "55555555-0000-4000-8000-000000000004";
const OTHER = "55555555-0000-4000-8000-000000000005";
const FC_FOLLOW = "55555555-0000-4000-8000-000000000006";
const U_FOLLOW = "55555555-0000-4000-8000-000000000007";

const STEPS = [
  { key: "meeting_booked", lifecycleRung: "meeting_booked", subjectKind: "person" },
  { key: "paid_client", lifecycleRung: "paid_client", subjectKind: "person" },
  { key: "message_sent", lifecycleRung: "contacted", subjectKind: "person" },
  { key: "email_queued", lifecycleRung: "none", subjectKind: "person", towardStep: "email_sent" },
];

const funnelDetail = (id: string) =>
  id === MEETING_FUNNEL
    ? {
        object: "sales_funnel",
        id,
        name: "Meetings",
        type: "proactive",
        legs: [
          { legKey: "start_to_lead_found", toStep: "lead_found", pipe: { id: `${SOURCING}|start_to_lead_found`, mode: "proactive" } },
          {
            legKey: "lead_found_to_conversation",
            toStep: "conversation",
            pipe: { id: `${COLD}|lead_found_to_conversation`, mode: "proactive" },
          },
          {
            legKey: "conversation_to_meeting_booked",
            toStep: "meeting_booked",
            pipe: { id: `${MEETING}|conversation_to_meeting_booked`, mode: "reactive" },
          },
          { legKey: "meeting_booked_to_meeting_attended", toStep: "meeting_attended", pipe: null },
          { legKey: "meeting_attended_to_paid_client", toStep: "paid_client", pipe: null },
        ],
      }
    : id === FOLLOW_UP_FUNNEL
      ? {
          object: "sales_funnel",
          id,
          name: "Nudge",
          type: "reactive",
          trigger: { slug: "follow_up_due" },
          legs: [{ legKey: "signup_to_paid_client", toStep: "paid_client", pipe: { id: `${FOLLOW_UP}|signup_to_paid_client`, mode: "reactive" } }],
        }
      : null;

interface Occ {
  outcomeKey: string;
  subjectId: string;
  campaignId: string | null;
  declaredAt: string;
}

const now = () => new Date().toISOString();
const LONG_AGO = "2026-01-05T10:00:00.000Z";

function mockUpstreams(ledger: Occ[]) {
  const calls = { occurrences: [] as URLSearchParams[], costs: 0 };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/internal/catalogue/sales-funnels/")) {
      const body = funnelDetail(decodeURIComponent(url.pathname.split("/").pop()!));
      return body ? Response.json(body) : Response.json({ reason: "sales_funnel_not_found" }, { status: 404 });
    }
    if (url.pathname === "/sales-funnel-campaigns") {
      const u = (campaignId: string, featureSlug: string, legKey: string, salesFunnelId: string) => ({
        campaignId,
        featureSlug,
        legKey,
        status: "ongoing",
        salesFunnelId,
      });
      return Response.json({
        salesFunnelCampaigns: [
          {
            id: FC,
            orgId,
            brandId,
            offerId: OFFER,
            salesFunnelId: MEETING_FUNNEL,
            name: "Meetings",
            target: "meeting_booked",
            status: "ongoing",
            units: [
              u(U_SOURCE, SOURCING, "start_to_lead_found", MEETING_FUNNEL),
              u(U_COLD, COLD, "lead_found_to_conversation", MEETING_FUNNEL),
              u(U_MEETING, MEETING, "conversation_to_meeting_booked", MEETING_FUNNEL),
            ],
          },
          {
            id: FC_FOLLOW,
            orgId,
            brandId,
            offerId: OFFER,
            salesFunnelId: FOLLOW_UP_FUNNEL,
            name: "Nudge",
            target: "paid_client",
            status: "ongoing",
            units: [u(U_FOLLOW, FOLLOW_UP, "signup_to_paid_client", FOLLOW_UP_FUNNEL)],
          },
        ],
      });
    }
    if (url.pathname === "/internal/campaigns/recurring-status") return Response.json({ campaigns: [] });
    if (url.pathname === "/v1/stats/costs") {
      calls.costs += 1;
      return Response.json({
        groups: url.searchParams
          .get("campaignIds")!
          .split(",")
          .map((id) => ({ dimensions: { campaignId: id }, totalCostInUsdCents: "1000", netTotalCostInUsdCents: "1000" })),
      });
    }
    if (url.pathname === "/v1/stats/run-outcomes") {
      return Response.json({
        scope: "all",
        groups: url.searchParams
          .get("campaignIds")!
          .split(",")
          .map((id) => ({ dimensions: { campaignId: id }, runCount: 4, completedCount: 3, failedCount: 0, runningCount: 1 })),
      });
    }
    if (url.pathname === "/internal/outcome-occurrences") {
      calls.occurrences.push(url.searchParams);
      const p = url.searchParams;
      const after = p.get("declaredAfter");
      const subjects = p.get("subjectIds")?.split(",");
      const rows = ledger.filter(
        (o) =>
          o.outcomeKey === p.get("outcomeKey") &&
          (!after || o.declaredAt >= after) &&
          (!subjects || (subjects.includes(o.subjectId) && p.get("subjectService") === "lead-service"))
      );
      return Response.json({
        occurrences: rows.map((o) => ({
          id: crypto.randomUUID(),
          runId: crypto.randomUUID(),
          direction: "produced",
          outcomeKey: o.outcomeKey,
          subjectService: "lead-service",
          subjectId: o.subjectId,
          quantity: "1.000000",
          declaredAt: o.declaredAt,
          tags: { brandIds: [brandId], campaignId: o.campaignId },
        })),
        nextCursor: null,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

const app = createTestApp();
const auth = getAuthHeaders(orgId, userId, runId);
const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const capsPath = (funnel: string, fc: string) =>
  `/brands/${brandId}/offers/${OFFER}/sales-funnels/${encodeURIComponent(funnel)}/campaigns/${fc}/caps`;
const put = (body: unknown, funnel = MEETING_FUNNEL, fc = FC) =>
  request(app).put(`/v1${capsPath(funnel, fc)}`).set(auth).send(body as object);
const read = (funnel = MEETING_FUNNEL, fc = FC) => request(app).get(`/internal${capsPath(funnel, fc)}`).set(internal);
const occ = (outcomeKey: string, subjectId: string, campaignId: string | null, declaredAt = now()): Occ => ({
  outcomeKey,
  subjectId,
  campaignId,
  declaredAt,
});
const TEN_A_WEEK = { maxBudget: { amountCents: "26000", period: "weekly" }, maxVolume: { count: 10, period: "weekly" } };

describe("sales funnel caps: a funnel campaign counts Units of its target", () => {
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
    __primeSalesPathTerms(
      [
        {
          slug: FOLLOW_UP,
          managed: true,
          stepTransitions: [{ legKey: "signup_to_paid_client", from: { key: "signup" }, to: { key: "paid_client" }, reactive: true }],
        },
      ] as never,
      { sourceLegKey: "start_to_lead_found", origins: [], originsByChannel: { [COLD]: [SOURCING] } } as never
    );
    __primeOutcomeSteps(STEPS);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetSalesPathTerms();
    __resetOutcomeSteps();
  });
  afterAll(async () => {
    for (const k of ["FEATURES_SERVICE_API_KEY", "CAMPAIGN_SERVICE_URL", "CAMPAIGN_SERVICE_API_KEY"]) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await cleanTestData();
    await closeDb();
  });

  it("10 meetings booked a week + $260: 3 of 10 meetings booked, funded, unit and outcome stated", async () => {
    mockUpstreams([
      occ("message_sent", "ann", U_COLD, LONG_AGO), // emailed weeks ago...
      occ("meeting_booked", "ann", null), // ...books today on the meeting producer's own run
      occ("message_sent", "bob", U_COLD),
      occ("meeting_booked", "bob", null),
      occ("meeting_booked", "cid", U_MEETING), // declared on the campaign's own unit
      occ("meeting_booked", "dan", null), // reached by another campaign only
      occ("message_sent", "dan", OTHER),
      occ("meeting_booked", "eve", null), // nobody reached her
      occ("meeting_booked", "fay", null, LONG_AGO), // booked before this week
      occ("message_sent", "fay", U_COLD, LONG_AGO),
    ]);
    expect((await put(TEN_A_WEEK)).status).toBe(200);
    const r = await read();
    expect(r.status).toBe(200);
    expect(r.body.capScope).toBe("sales_funnel_campaign");
    expect(r.body.funded).toBe(true);
    expect(r.body.fundedBy).toBe("both");
    expect(r.body.volumeUnit).toBe("outcomes_produced");
    expect(r.body.maxVolume).toMatchObject({
      count: 10,
      period: "weekly",
      unit: "outcomes_produced",
      outcome: "meeting_booked",
      consumed: 3,
      remaining: 7,
      reached: false,
      consumedUnavailableReason: null,
    });
    expect(r.body.maxBudget).toMatchObject({ amountCents: "26000.0000000000", period: "weekly", reached: false });
  });

  it("a meeting booked BEFORE the person was reached is not the campaign's", async () => {
    mockUpstreams([
      occ("meeting_booked", "gus", null, new Date(Date.now() - 60_000).toISOString()),
      occ("message_sent", "gus", U_COLD),
    ]);
    await put(TEN_A_WEEK);
    expect((await read()).body.maxVolume).toMatchObject({ consumed: 0, reached: false });
  });

  it("weeks of emails and no meeting yet: 0 of 10, never holds the campaign (the budget is its ceiling)", async () => {
    mockUpstreams([occ("message_sent", "ann", U_COLD), occ("email_queued", "bob", U_COLD)]);
    await put(TEN_A_WEEK);
    const r = await read();
    expect(r.body.maxVolume).toMatchObject({ unit: "outcomes_produced", outcome: "meeting_booked", consumed: 0, reached: false });
  });

  it("10 meetings reached: reached = true", async () => {
    const ledger: Occ[] = [];
    for (let i = 0; i < 10; i += 1) ledger.push(occ("message_sent", `p${i}`, U_COLD, LONG_AGO), occ("meeting_booked", `p${i}`, null));
    mockUpstreams(ledger);
    await put(TEN_A_WEEK);
    expect((await read()).body.maxVolume).toMatchObject({ consumed: 10, remaining: 0, reached: true });
  });

  it("the brand list states the same unit and outcome", async () => {
    mockUpstreams([]);
    await put(TEN_A_WEEK);
    const r = await request(app).get(`/internal/brands/${brandId}/sales-funnel-caps`).set(internal);
    expect(r.status).toBe(200);
    expect(r.body.caps[0].maxVolume).toEqual({ count: 10, period: "weekly", unit: "outcomes_produced", outcome: "meeting_booked" });
  });

  it("a follow-up whose target is reached by its own first contact keeps its unit (Copilot « max volume 1 »)", async () => {
    mockUpstreams([occ("paid_client", "ann", U_FOLLOW)]);
    expect((await put({ maxBudget: { amountCents: 500000, period: "one_off" }, maxVolume: { count: 1, period: "one_off" } }, FOLLOW_UP_FUNNEL, FC_FOLLOW)).status).toBe(200);
    const r = await read(FOLLOW_UP_FUNNEL, FC_FOLLOW);
    expect(r.body.volumeUnit).toBe("prospects_handled");
    expect(r.body.maxVolume.unit).toBe("prospects_handled");
    expect(r.body.maxVolume.outcome).toBeNull();
  });

  it("the funnel-wide cap of the same funnel keeps first contacts", async () => {
    mockUpstreams([]);
    const path = `/brands/${brandId}/offers/${OFFER}/sales-funnels/${encodeURIComponent(MEETING_FUNNEL)}/caps`;
    expect((await request(app).put(`/v1${path}`).set(auth).send(TEN_A_WEEK)).status).toBe(200);
    const r = await request(app).get(`/internal${path}`).set(internal);
    expect(r.body.maxVolume).toMatchObject({ unit: "first_contacts", outcome: null });
  });
});

describe("targetReachedAfterFirstContact (pure)", () => {
  const p = (channelSlug: string, legKey: string, toStep: string, runByUs: boolean | null = true) => ({
    channelSlug,
    legKey,
    toStep,
    runByUs,
  });
  const isSource = (x: { channelSlug: string }) => x.channelSlug === SOURCING;
  it("meeting booked after the cold email: true", () => {
    const pipes = [
      p(SOURCING, "start_to_lead_found", "lead_found"),
      p(COLD, "lead_found_to_conversation", "conversation"),
      p(MEETING, "conversation_to_meeting_booked", "meeting_booked"),
    ];
    expect(targetReachedAfterFirstContact(pipes, "meeting_booked", isSource)).toBe(true);
  });
  it("the first contact's own step, a step after only a lead source, or our team's step: false", () => {
    expect(targetReachedAfterFirstContact([p(FOLLOW_UP, "signup_to_paid_client", "paid_client")], "paid_client", isSource)).toBe(false);
    expect(
      targetReachedAfterFirstContact(
        [p(SOURCING, "start_to_lead_found", "lead_found"), p(FOLLOW_UP, "lead_found_to_paid_client", "paid_client")],
        "paid_client",
        isSource
      )
    ).toBe(false);
    expect(
      targetReachedAfterFirstContact(
        [p(COLD, "lead_found_to_conversation", "conversation"), p("your-team-closing-calls", "conversation_to_paid_client", "paid_client", false)],
        "paid_client",
        isSource
      )
    ).toBe(false);
  });
});
