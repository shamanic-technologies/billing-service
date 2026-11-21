/**
 * OUTREACH-3WAYS-1121: a campaign launched on its TARGET alone whose target is about a PERSON
 * (Paid client) reaches people. A client stating "at most 2 new people a day" gets a max volume
 * counted in FIRST CONTACTS: the distinct people the campaign's units sent a first message to in
 * the window (runs-service ledger, outcomes the catalogue files on the `contacted` rung about a
 * person). A second email, a follow-up or an answer to a person already contacted is never a new
 * person; another campaign's send is never this one's.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { __resetSalesFunnelCache } from "../../src/lib/sales-funnel-catalogue.js";
import { __primeSalesPathTerms, __resetSalesPathTerms } from "../../src/lib/sales-path-terms.js";
import { __primeOutcomeSteps, __resetOutcomeSteps } from "../../src/lib/outcome-steps.js";
import { __resetStepEvidence } from "../../src/lib/sales-funnel-caps.js";

const orgId = "00000000-0000-4000-8000-000000112101";
const userId = "00000000-0000-4000-8000-000000112109";
const runId = "00000000-0000-4000-8000-00000011210a";
const brandId = "00000000-0000-4000-8000-000000112111";
const OFFER = "aaaaaaaa-1121-4121-8121-aaaaaaaaaaaa";

const TARGET = "paid_client";
const FC = "44444444-0000-4000-8000-000000000001";
const UNIT = "44444444-0000-4000-8000-000000000002";
const PLAN_UNIT = "44444444-0000-4000-8000-000000000003";
const OTHER = "44444444-0000-4000-8000-000000000004";

const STEPS = [
  { key: "paid_client", lifecycleRung: "paid_client", subjectKind: "person" },
  { key: "message_sent", lifecycleRung: "contacted", subjectKind: "person" },
  { key: "whatsapp_message_sent", lifecycleRung: "contacted", subjectKind: "person" },
  { key: "newsletter_email_sent", lifecycleRung: "contacted", subjectKind: "object" },
  { key: "email_sent", lifecycleRung: "contacted", subjectKind: null },
  { key: "email_queued", lifecycleRung: "none", subjectKind: "person", towardStep: "email_sent" },
  { key: "lead_found", lifecycleRung: "lead_found", subjectKind: "person", towardStep: "lead_identified" },
];

const app = createTestApp();
const auth = getAuthHeaders(orgId, userId, runId);
const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const capsPath = `/brands/${brandId}/offers/${OFFER}/sales-funnels/${TARGET}/campaigns/${FC}/caps`;

interface Occ {
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  campaignId: string | null;
  declaredAt: string;
}

const today = () => new Date().toISOString();
const PAST = "2026-01-05T10:00:00.000Z";

function occurrence(o: Occ) {
  return {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    direction: "produced",
    outcomeKey: o.outcomeKey,
    subjectService: o.subjectService,
    subjectId: o.subjectId,
    quantity: "1.000000",
    declaredAt: o.declaredAt,
    tags: { brandIds: [brandId], campaignId: o.campaignId, workflowSlug: null, featureSlug: null, audienceId: null },
  };
}

function mockUpstreams(ledger: Occ[], opts: { featuresStatus?: number } = {}) {
  const calls = { occurrences: [] as URLSearchParams[], steps: 0 };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/public/catalogue/steps") {
      calls.steps += 1;
      return Response.json({ error: "down" }, { status: opts.featuresStatus ?? 503 });
    }
    if (url.pathname.startsWith("/internal/catalogue/sales-funnels/")) {
      return Response.json({ reason: "sales_funnel_not_found" }, { status: 404 });
    }
    if (url.pathname === "/sales-funnel-campaigns") {
      const unit = (campaignId: string, featureSlug: string | null, legKey: string | null) => ({
        campaignId,
        pipeId: null,
        featureSlug,
        legKey,
        status: "ongoing",
        workflowSlug: `engine:${TARGET}`,
        name: "Intros",
        salesFunnelId: TARGET,
        planRole: null,
        runsOnTriggerId: null,
      });
      return Response.json({
        salesFunnelCampaigns: [
          {
            id: FC,
            orgId,
            brandId,
            offerId: OFFER,
            salesFunnelId: TARGET,
            salesFunnelName: null,
            name: "Intros",
            target: TARGET,
            status: "ongoing",
            units: [unit(UNIT, null, null), unit(PLAN_UNIT, "ai-follow-up-email", "start_to_paid_client")],
          },
        ],
      });
    }
    if (url.pathname === "/internal/campaigns/recurring-status") {
      return Response.json({ campaigns: [] });
    }
    if (url.pathname === "/internal/outcome-occurrences") {
      calls.occurrences.push(url.searchParams);
      const p = url.searchParams;
      const after = p.get("declaredAfter");
      const before = p.get("declaredBefore");
      const subjects = p.get("subjectIds")?.split(",");
      const rows = ledger.filter(
        (o) =>
          o.outcomeKey === p.get("outcomeKey") &&
          (!after || o.declaredAt >= after) &&
          (!before || o.declaredAt < before) &&
          (!subjects || (subjects.includes(o.subjectId) && o.subjectService === p.get("subjectService")))
      );
      return Response.json({ occurrences: rows.map(occurrence), nextCursor: null });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

const put = (body: unknown) => request(app).put(`/v1${capsPath}`).set(auth).send(body as object);
const read = () => request(app).get(`/internal${capsPath}`).set(internal);
const sent = (subjectId: string, campaignId: string | null, declaredAt = today(), outcomeKey = "message_sent", subjectService = "lead-service"): Occ => ({
  outcomeKey,
  subjectService,
  subjectId,
  campaignId,
  declaredAt,
});

describe("sales funnel caps: a target-only campaign that reaches people counts first contacts", () => {
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
          slug: "ai-follow-up-email",
          managed: true,
          stepTransitions: [{ legKey: "start_to_paid_client", from: null, to: { key: "paid_client" }, reactive: true }],
        },
      ] as never,
      { sourceLegKey: "start_to_lead_found", origins: [], originsByChannel: {} } as never
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

  it("max volume 2/day: two new people reached it; a follow-up and an older contact are not new people", async () => {
    const calls = mockUpstreams([
      sent("lead-a", UNIT),
      sent("lead-a", UNIT), // a follow-up to the same person
      sent("lead-b", PLAN_UNIT), // the plan's unit is the campaign's too
      sent("lead-c", UNIT, PAST), // contacted before today...
      sent("lead-c", UNIT), // ...answered today: not a new person
      sent("lead-d", OTHER), // another campaign's send
      sent("lead-e", null),
    ]);
    expect((await put({ maxBudget: null, maxVolume: { count: 2, period: "daily" } })).status).toBe(200);
    const r = await read();
    expect(r.status).toBe(200);
    expect(r.body.volumeUnit).toBe("first_contacts");
    expect(r.body.maxVolume).toMatchObject({
      count: 2,
      unit: "first_contacts",
      consumed: 2,
      remaining: 0,
      reached: true,
      consumedUnavailableReason: null,
    });
    // Counted on the sender's own declaration, never the target outcome.
    expect(calls.occurrences.every((p) => p.get("outcomeKey") !== TARGET)).toBe(true);
    expect(new Set(calls.occurrences.map((p) => p.get("outcomeKey")))).toEqual(
      new Set(["email_queued", "message_sent", "whatsapp_message_sent"])
    );
  });

  it("the queue decision counts the person the moment the send is decided: the 3rd new person is held", async () => {
    // Two people queued this morning; the throttled mailbox has not sent either yet. One person
    // queued and sent. A lead merely FOUND is nobody contacted.
    mockUpstreams([
      sent("lead-q1", UNIT, today(), "email_queued"),
      sent("lead-q2", UNIT, today(), "email_queued"),
      sent("lead-q2", UNIT, today(), "message_sent"),
      sent("lead-found-only", UNIT, today(), "lead_found"),
    ]);
    await put({ maxBudget: null, maxVolume: { count: 2, period: "daily" } });
    expect((await read()).body.maxVolume).toMatchObject({ unit: "first_contacts", consumed: 2, remaining: 0, reached: true });
  });

  it("one new person: 1 of 2, not reached (campaign-service keeps contacting)", async () => {
    mockUpstreams([sent("lead-a", UNIT), sent("lead-a", UNIT)]);
    await put({ maxBudget: null, maxVolume: { count: 2, period: "daily" } });
    expect((await read()).body.maxVolume).toMatchObject({ unit: "first_contacts", consumed: 1, remaining: 1, reached: false });
  });

  it("a WhatsApp first message is a new person too; nothing sent yet reads 0, never unmeasured", async () => {
    mockUpstreams([sent("person-w", UNIT, today(), "whatsapp_message_sent", "crm-service")]);
    await put({ maxBudget: null, maxVolume: { count: 2, period: "daily" } });
    expect((await read()).body.maxVolume).toMatchObject({ consumed: 1, reached: false });

    vi.restoreAllMocks();
    mockUpstreams([]);
    expect((await read()).body.maxVolume).toMatchObject({ consumed: 0, remaining: 2, reached: false, consumedUnavailableReason: null });
  });

  it("the outcome catalogue never read and features-service down: unmeasured (campaign-service holds), never 0", async () => {
    __resetOutcomeSteps();
    const calls = mockUpstreams([sent("lead-a", UNIT)]);
    await put({ maxBudget: null, maxVolume: { count: 2, period: "daily" } });
    const r = await read();
    expect(calls.steps).toBeGreaterThan(0);
    expect(r.body.maxVolume).toMatchObject({ consumed: null, reached: null, consumedUnavailableReason: "sales_funnel_catalogue_unavailable" });
  });
});
