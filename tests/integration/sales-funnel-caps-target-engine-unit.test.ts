/**
 * PLAN-RECURSIVE-PER-ENGINE-1124: campaign-service moves an EXISTING funnel campaign onto ONE unit
 * on its Target's Engine (no channel, no leg, `engine:<target>`); its older units drain. The
 * campaign keeps its real funnel id, its caps stay keyed on it. That Engine unit is capped like a
 * target-only campaign's unit: its spend counts, its volume is measured as a target-only
 * campaign's; the drained units keep being measured. Before: the unit read as pipe `null|null`,
 * unknown to the channel catalogue, and the whole caps read failed closed.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { __resetSalesFunnelCache } from "../../src/lib/sales-funnel-catalogue.js";
import { __primeSalesPathTerms, __resetSalesPathTerms } from "../../src/lib/sales-path-terms.js";
import { __primeOutcomeSteps, __resetOutcomeSteps } from "../../src/lib/outcome-steps.js";
import { __resetStepEvidence } from "../../src/lib/sales-funnel-caps.js";

const orgId = "00000000-0000-4000-8000-000000112401";
const userId = "00000000-0000-4000-8000-000000112409";
const runId = "00000000-0000-4000-8000-00000011240a";
const brandId = "00000000-0000-4000-8000-000000112411";
const OFFER = "aaaaaaaa-1124-4124-8124-aaaaaaaaaaaa";

const THREADS = "threads-post";
const FUNNEL = "start_to_threads_post_published@threads-post+threads_post_published_to_paid_client";
const TARGET = "signup";
const FC = "55555555-0000-4000-8000-000000000001";
const U_THREADS = "55555555-0000-4000-8000-000000000002";
const U_ENGINE = "55555555-0000-4000-8000-000000000003";
const OTHER = "55555555-0000-4000-8000-000000000004";

const STEPS = [
  { key: "signup", lifecycleRung: "signup", subjectKind: "person" },
  { key: "threads_post_published", lifecycleRung: "none", subjectKind: "object" },
  { key: "message_sent", lifecycleRung: "contacted", subjectKind: "person" },
];

const app = createTestApp();
const auth = getAuthHeaders(orgId, userId, runId);
const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const capsPath = `/brands/${brandId}/offers/${OFFER}/sales-funnels/${encodeURIComponent(FUNNEL)}/campaigns/${FC}/caps`;

interface Occ {
  outcomeKey: string;
  subjectId: string;
  campaignId: string | null;
  declaredAt: string;
}

function mockUpstreams(units: Array<{ campaignId: string; featureSlug: string | null; legKey: string | null }>, ledger: Occ[]) {
  const calls = { costs: [] as URLSearchParams[], channels: 0 };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/internal/catalogue/sales-funnels/")) {
      if (decodeURIComponent(url.pathname.split("/").pop()!) !== FUNNEL) {
        return Response.json({ reason: "sales_funnel_not_found" }, { status: 404 });
      }
      return Response.json({
        object: "sales_funnel",
        id: FUNNEL,
        name: "Threads Posts",
        type: "proactive",
        legs: [
          {
            legKey: "start_to_threads_post_published",
            toStep: "threads_post_published",
            pipe: { id: `${THREADS}|start_to_threads_post_published`, mode: "proactive" },
          },
          { legKey: "threads_post_published_to_paid_client", toStep: "paid_client", pipe: null },
        ],
      });
    }
    if (url.pathname === "/sales-funnel-campaigns") {
      return Response.json({
        salesFunnelCampaigns: [
          {
            id: FC,
            orgId,
            brandId,
            offerId: OFFER,
            salesFunnelId: FUNNEL,
            salesFunnelName: "Threads Posts",
            name: "Threads Posts",
            target: TARGET,
            status: "ongoing",
            units: units.map((u) => ({
              ...u,
              pipeId: null,
              status: "ongoing",
              workflowSlug: u.featureSlug == null ? `engine:${TARGET}` : `${u.featureSlug}`,
            })),
          },
        ],
      });
    }
    if (url.pathname === "/internal/campaigns/recurring-status") return Response.json({ campaigns: [] });
    if (url.pathname === "/v1/stats/costs") {
      calls.costs.push(url.searchParams);
      return Response.json({
        groups: url.searchParams
          .get("campaignIds")!
          .split(",")
          .map((id) => ({ dimensions: { campaignId: id }, totalCostInUsdCents: "999", netTotalCostInUsdCents: "50.5" })),
      });
    }
    if (url.pathname === "/internal/outcome-occurrences") {
      const p = url.searchParams;
      const after = p.get("declaredAfter");
      const before = p.get("declaredBefore");
      const rows = ledger.filter(
        (o) => o.outcomeKey === p.get("outcomeKey") && (!after || o.declaredAt >= after) && (!before || o.declaredAt < before)
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
          tags: { brandIds: [brandId], campaignId: o.campaignId, workflowSlug: null, featureSlug: null, audienceId: null },
        })),
        nextCursor: null,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

const put = (body: unknown) => request(app).put(`/v1${capsPath}`).set(auth).send(body as object);
const read = () => request(app).get(`/internal${capsPath}`).set(internal);
const CAPS = { maxBudget: { amountCents: 200, period: "daily" }, maxVolume: { count: 1, period: "daily" } };
const now = () => new Date().toISOString();

describe("sales funnel caps: a funnel campaign's unit on its Target's Engine", () => {
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
          slug: THREADS,
          managed: true,
          stepTransitions: [
            { legKey: "start_to_threads_post_published", from: null, to: { key: "threads_post_published" }, reactive: false },
          ],
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

  it("answers figures: the Engine unit's spend counts beside the drained unit's, volume counted as a target-only campaign's", async () => {
    const calls = mockUpstreams(
      [
        { campaignId: U_THREADS, featureSlug: THREADS, legKey: "start_to_threads_post_published" },
        { campaignId: U_ENGINE, featureSlug: null, legKey: null },
      ],
      [
        { outcomeKey: "message_sent", subjectId: "lead-a", campaignId: U_ENGINE, declaredAt: now() },
        { outcomeKey: "message_sent", subjectId: "lead-b", campaignId: OTHER, declaredAt: now() },
      ]
    );
    expect((await put(CAPS)).status).toBe(200);
    const r = await read();
    expect(r.status).toBe(200);
    expect(r.body.capScope).toBe("sales_funnel_campaign");
    // Spend: both units of the campaign (2 x 50.5).
    expect(calls.costs[0]!.get("campaignIds")!.split(",").sort()).toEqual([U_THREADS, U_ENGINE].sort());
    expect(r.body.maxBudget).toMatchObject({ consumedCents: "101.0000000000", reached: false, consumedUnavailableReason: null });
    // Target `signup` is about a person: the new people the campaign first contacted.
    expect(r.body.volumeUnit).toBe("first_contacts");
    expect(r.body.maxVolume).toMatchObject({ unit: "first_contacts", consumed: 1, reached: true, consumedUnavailableReason: null });
    const engine = (r.body.pipes as Array<Record<string, unknown>>).find((p) => p.channelSlug === `engine:${TARGET}`);
    expect(engine).toMatchObject({
      pipeId: `engine:${TARGET}|start_to_${TARGET}`,
      legKey: `start_to_${TARGET}`,
      mode: "proactive",
      toStep: TARGET,
      targetOnly: true,
      campaignIds: [U_ENGINE],
    });
    expect((r.body.pipes as Array<{ pipeId: string }>).map((p) => p.pipeId)).not.toContain("null|null");
  });

  it("before the move (drained units only): read as before, the Threads unit's spend counted", async () => {
    const calls = mockUpstreams([{ campaignId: U_THREADS, featureSlug: THREADS, legKey: "start_to_threads_post_published" }], []);
    await put(CAPS);
    const r = await read();
    expect(r.status).toBe(200);
    expect(calls.costs[0]!.get("campaignIds")).toBe(U_THREADS);
    expect(r.body.maxBudget).toMatchObject({ consumedCents: "50.5000000000", consumedUnavailableReason: null });
    expect((r.body.pipes as Array<{ pipeId: string }>).map((p) => p.pipeId)).toEqual([`${THREADS}|start_to_threads_post_published`]);
  });
});
