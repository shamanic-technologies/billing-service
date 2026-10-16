/**
 * A caller that PROVISIONS before it authorizes (chat-service /complete) is not
 * counted twice (FUNNEL-CAP-OWN-HOLD-1016, prod 2026-10-15/16): cap 350c, 226c
 * consumed, the run provisions 66c then authorizes 66c -> granted (226 + 66 <= 350),
 * while a spend that truly overflows is refused and the caps read says reached.
 *
 * Own file (CLAUDE.md: one describe per file that closes the DB).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { salesFunnelCaps } from "../../src/db/schema.js";
import { __resetSalesFunnelCache } from "../../src/lib/sales-funnel-catalogue.js";
import { __primeSalesPathTerms, __resetSalesPathTerms } from "../../src/lib/sales-path-terms.js";
import { __resetFunnelCapAuthorize } from "../../src/lib/funnel-cap-authorize.js";

const orgId = "00000000-0000-0000-0000-0000000086a1";
const userId = "00000000-0000-0000-0000-0000000086a9";
const runId = "00000000-0000-0000-0000-0000000086ab";
const brandId = "00000000-0000-0000-0000-000000086b01";
const OFFER = "aaaaaaaa-1186-4186-8186-aaaaaaaaaaaa";
const FUNNEL = "start_to_paid_client@leads-only";
const FC = "cccccccc-0000-4000-8000-0000000086c1";
const SOURCE_UNIT = "11111111-0000-4000-8000-0000000086d1";
const TEAM_UNIT = "11111111-0000-4000-8000-0000000086d2";
const SOURCE = "sourcing-apollo-cold-filters";
const TEAM = "your-team";

const app = createTestApp();
const items = [
  { costName: "anthropic-opus-5.5-tokens-input", quantity: 2341 },
  { costName: "anthropic-opus-5.5-tokens-output", quantity: 16000 },
];
const body = { items, description: "llm complete" };
const HOLD = { input: "1.8728000000", output: "64.0000000000" };

const statusOf = (campaignId: string, featureSlug: string, legKey: string) => ({
  campaignId,
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

interface Hold {
  runId: string;
  campaignId: string;
  orgId?: string;
  status?: string;
  /** ms before now the hold was written (default 2s: before the measurement). */
  ageMs?: number;
}

interface Upstreams {
  holds?: Hold[];
  runReads?: number;
  /** NET committed cents per campaign id, as runs-service /v1/stats/costs answers. */
  spent: Record<string, string>;
  costsStatus?: number;
  campaignReads: number;
  costReads: number;
}

function mockUpstreams(u: Upstreams): Upstreams {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (/^\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) return Response.json({ ok: true });
    const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
    if (runMatch) {
      u.runReads = (u.runReads ?? 0) + 1;
      const h = (u.holds ?? []).find((x) => x.runId === runMatch[1]);
      if (!h) return new Response("Run not found", { status: 404 });
      const at = new Date(Date.now() - (h.ageMs ?? 2_000)).toISOString();
      return Response.json({
        id: h.runId,
        organizationId: h.orgId ?? orgId,
        campaignId: h.campaignId,
        costs: [
          { id: `${h.runId}-in`, costName: items[0].costName, quantity: "2341.000000", status: h.status ?? "provisioned", netCostInUsdCents: HOLD.input, totalCostInUsdCents: HOLD.input, createdAt: at },
          { id: `${h.runId}-out`, costName: items[1].costName, quantity: "16000.000000", status: h.status ?? "provisioned", netCostInUsdCents: HOLD.output, totalCostInUsdCents: HOLD.output, createdAt: at },
        ],
      });
    }
    if (url.pathname.startsWith("/internal/catalogue/sales-funnels/")) {
      return Response.json({
        object: "sales_funnel",
        id: FUNNEL,
        name: "Leads only",
        type: "proactive",
        legs: [
          { legKey: "start_to_lead_found", pipe: { id: `${SOURCE}|start_to_lead_found`, mode: "proactive" } },
          { legKey: "lead_found_to_paid_client", pipe: { id: `${TEAM}|lead_found_to_paid_client`, mode: "proactive" } },
        ],
      });
    }
    if (url.pathname === "/internal/campaigns/recurring-status") {
      return Response.json({
        campaigns: [
          statusOf(SOURCE_UNIT, SOURCE, "start_to_lead_found"),
          statusOf(TEAM_UNIT, TEAM, "lead_found_to_paid_client"),
        ],
      });
    }
    if (url.pathname === "/sales-funnel-campaigns") {
      u.campaignReads += 1;
      return Response.json({
        salesFunnelCampaigns: [
          {
            id: FC,
            brandId,
            offerId: OFFER,
            salesFunnelId: FUNNEL,
            salesFunnelName: "Leads only",
            status: "ongoing",
            units: [
              { campaignId: SOURCE_UNIT, featureSlug: SOURCE, legKey: "start_to_lead_found", status: "ongoing" },
              { campaignId: TEAM_UNIT, featureSlug: TEAM, legKey: "lead_found_to_paid_client", status: "ongoing" },
            ],
          },
        ],
      });
    }
    if (url.pathname === "/v1/stats/costs") {
      u.costReads += 1;
      if (u.costsStatus) return new Response("down", { status: u.costsStatus });
      return Response.json({
        groups: url.searchParams
          .get("campaignIds")!
          .split(",")
          .map((id) => ({ dimensions: { campaignId: id }, netTotalCostInUsdCents: u.spent[id] ?? "0" })),
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return u;
}

async function stateCap(opts: { budgetCents?: string | null; volume?: number | null; own?: boolean } = {}) {
  const budget = opts.budgetCents === undefined ? "350" : opts.budgetCents;
  await db.insert(salesFunnelCaps).values({
    orgId,
    brandId,
    offerId: OFFER,
    salesFunnelId: FUNNEL,
    salesFunnelCampaignId: opts.own === false ? null : FC,
    maxBudgetCents: budget,
    maxBudgetPeriod: budget === null ? null : "one_off",
    maxBudgetSince: budget === null ? null : new Date(Date.now() - 3_600_000),
    maxVolume: opts.volume ?? null,
    maxVolumePeriod: opts.volume ? "one_off" : null,
    maxVolumeSince: opts.volume ? new Date(Date.now() - 3_600_000) : null,
    salesFunnelType: "proactive",
  });
}

describe("a funnel max budget does not count the caller's own provisioned hold twice", () => {
  const savedEnv = { ...process.env };
  let required = "65.8728000000";

  beforeAll(() => {
    process.env.FEATURES_SERVICE_API_KEY = "test-features-key";
    process.env.CAMPAIGN_SERVICE_URL = "http://localhost:9994";
    process.env.CAMPAIGN_SERVICE_API_KEY = "test-campaign-key";
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    __resetSalesFunnelCache();
    __resetFunnelCapAuthorize();
    __primeSalesPathTerms([], { sourceLegKey: "start_to_lead_found", origins: [], originsByChannel: {} } as never);
    const ss = setupStripeMocks();
    ss.sumSucceededTopupsForOrg.mockResolvedValue("100000.0000000000");
    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockImplementation(async () => required);
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-10-16T00:00:00.000Z",
    });
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 1000 });
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

  const authorize = (campaignId: string, cents: string, run = runId) => {
    required = cents;
    return request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId, userId, run), "x-campaign-id": campaignId })
      .send(body);
  };
  const readCap = () =>
    request(app)
      .get(`/internal/brands/${brandId}/offers/${OFFER}/sales-funnels/${encodeURIComponent(FUNNEL)}/campaigns/${FC}/caps`)
      .set({ "X-API-Key": "test-api-key", "x-org-id": orgId });

  it("prod case: cap 350, 226 consumed, the run provisioned 66 then authorizes 66 -> GRANTED", async () => {
    // runs-service's consumption already holds the 65.87c provision (226.22 + 65.87).
    const u = mockUpstreams({
      spent: { [TEAM_UNIT]: "292.0928000000" },
      holds: [{ runId, campaignId: TEAM_UNIT }],
      campaignReads: 0,
      costReads: 0,
    });
    await stateCap();

    const res = await authorize(TEAM_UNIT, "65.8728000000");
    expect(res.body.sufficient).toBe(true);
    expect(res.body.reason).toBeUndefined();
    expect(u.runReads).toBe(1);

    const [row] = await db.select().from(salesFunnelCaps);
    expect(row.maxBudgetRefusedAt).toBeNull();
  });

  it("authorize's consumed figure equals the caps read's when the run carries its own hold", async () => {
    // The caps read campaign-service trusted: 226.22 (no hold yet).
    const u = mockUpstreams({ spent: { [TEAM_UNIT]: "226.2200000000" }, holds: [{ runId, campaignId: TEAM_UNIT }], campaignReads: 0, costReads: 0 });
    await stateCap({ budgetCents: "280" });
    const before = await readCap();
    expect(before.body.maxBudget.consumedCents).toBe("226.2200000000");
    expect(before.body.maxBudget.reached).toBe(false);

    // The run provisions 65.87 (now in runs-service's figure), then authorizes.
    u.spent[TEAM_UNIT] = "292.0928000000";
    const res = await authorize(TEAM_UNIT, "65.8728000000");
    expect(res.body.sufficient).toBe(false);
    expect(res.body.sales_funnel_cap.consumedCents).toBe(before.body.maxBudget.consumedCents);

    // 226.22 + 65.87 > 280 is a real overflow: recorded; the hold is released, the read says reached.
    u.spent[TEAM_UNIT] = "226.2200000000";
    const after = await readCap();
    expect(after.body.maxBudget.consumedCents).toBe("226.2200000000");
    expect(after.body.maxBudget.reached).toBe(true);
    expect(after.body.maxBudget.refusedSpend.requiredCents).toBe("65.8728000000");
  });

  it("a spend that truly overflows (300 consumed + 66 > 350) is refused and the read says reached", async () => {
    mockUpstreams({
      spent: { [TEAM_UNIT]: "365.8728000000" },
      holds: [{ runId, campaignId: TEAM_UNIT }],
      campaignReads: 0,
      costReads: 0,
    });
    await stateCap();

    const res = await authorize(TEAM_UNIT, "65.8728000000");
    expect(res.body.sufficient).toBe(false);
    expect(res.body.reason).toBe("sales_funnel_max_budget_reached");
    expect(res.body.sales_funnel_cap.consumedCents).toBe("300.0000000000");

    const cap = await readCap();
    expect(cap.body.maxBudget.reached).toBe(true);
    expect(cap.body.maxBudget.refusedSpend).toMatchObject({ requiredCents: "65.8728000000" });
  });

  it("a hold on ANOTHER campaign, a cancelled hold, or an old hold is not this spend's: not excluded", async () => {
    for (const hold of [
      { runId, campaignId: SOURCE_UNIT },
      { runId, campaignId: TEAM_UNIT, status: "cancelled" },
      { runId, campaignId: TEAM_UNIT, ageMs: 10 * 60_000 },
      { runId, campaignId: TEAM_UNIT, orgId: "00000000-0000-0000-0000-0000000086ff" },
    ]) {
      await cleanTestData();
      __resetFunnelCapAuthorize();
      await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 1000 });
      mockUpstreams({ spent: { [TEAM_UNIT]: "292.0928000000" }, holds: [hold], campaignReads: 0, costReads: 0 });
      await stateCap();
      const res = await authorize(TEAM_UNIT, "65.8728000000");
      expect(res.body.sufficient).toBe(false);
      expect(res.body.sales_funnel_cap.consumedCents).toBe("292.0928000000");
    }
  });

  it("one hold is excluded ONCE: a second authorize on the same run counts it", async () => {
    mockUpstreams({
      spent: { [TEAM_UNIT]: "292.0928000000" },
      holds: [{ runId, campaignId: TEAM_UNIT }],
      campaignReads: 0,
      costReads: 0,
    });
    await stateCap();
    expect((await authorize(TEAM_UNIT, "65.8728000000")).body.sufficient).toBe(true);
    const again = await authorize(TEAM_UNIT, "65.8728000000");
    expect(again.body.sufficient).toBe(false);
  });

  it("two concurrent runs each with its own hold cannot both slip under", async () => {
    // Cap 350, 226.22 really consumed + two fresh holds of 65.87 = 357.97 measured.
    const runB = "00000000-0000-0000-0000-0000000086ac";
    mockUpstreams({
      spent: { [TEAM_UNIT]: "357.9656000000" },
      holds: [
        { runId, campaignId: TEAM_UNIT },
        { runId: runB, campaignId: TEAM_UNIT },
      ],
      campaignReads: 0,
      costReads: 0,
    });
    await stateCap();
    const [a, b] = await Promise.all([authorize(TEAM_UNIT, "65.8728000000", runId), authorize(TEAM_UNIT, "65.8728000000", runB)]);
    // Each alone would leave 292.09 + 65.87 > 350: the other's hold is real spend.
    expect([a, b].filter((r) => r.body.sufficient === true)).toHaveLength(0);
  });

  it("a run read that fails does not exclude anything (stops early, never late)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mockUpstreams({ spent: { [TEAM_UNIT]: "292.0928000000" }, holds: [], campaignReads: 0, costReads: 0 });
    await stateCap();
    const res = await authorize(TEAM_UNIT, "65.8728000000");
    expect(res.body.sufficient).toBe(false);
    expect(res.body.sales_funnel_cap.consumedCents).toBe("292.0928000000");
    expect(err).toHaveBeenCalled();
  });

  it("a spend with room reads no run at all", async () => {
    const u = mockUpstreams({ spent: { [TEAM_UNIT]: "100" }, holds: [{ runId, campaignId: TEAM_UNIT }], campaignReads: 0, costReads: 0 });
    await stateCap();
    expect((await authorize(TEAM_UNIT, "65.8728000000")).body.sufficient).toBe(true);
    expect(u.runReads ?? 0).toBe(0);
  });
});
