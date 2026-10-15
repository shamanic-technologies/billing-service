/**
 * A SALES FUNNEL MAX BUDGET binds every spend at authorize, BEFORE it happens
 * (lib/funnel-cap-authorize.ts, LEADS-ONLY-FUNNEL-CAMPAIGN 2026-10-12). A $5
 * one-off cap with 495c consumed refuses a 16c spend and lets a 4c one through;
 * two concurrent spends cannot both slip under; a campaign no max budget holds is
 * byte-identical; our own platform org is held too (a cap is not a balance question).
 *
 * Own file (CLAUDE.md: one describe per file that closes the DB).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, listEpisodes, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { platformOrgs, salesFunnelCaps } from "../../src/db/schema.js";
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
const NOT_A_UNIT = "11111111-0000-4000-8000-0000000086d9";
const SOURCE = "sourcing-apollo-cold-filters";
const TEAM = "your-team";

const app = createTestApp();
const body = { items: [{ costName: "apollo-enrichment", quantity: 1 }], description: "lead serve" };

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

interface Upstreams {
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
          statusOf(NOT_A_UNIT, "cold-email-outreach", "lead_found_to_conversation"),
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
  const budget = opts.budgetCents === undefined ? "500" : opts.budgetCents;
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

describe("a sales funnel max budget binds every spend at authorize", () => {
  const savedEnv = { ...process.env };
  let ss: ReturnType<typeof setupStripeMocks>;
  let required = "16.0000000000";

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
    ss = setupStripeMocks();
    ss.sumSucceededTopupsForOrg.mockResolvedValue("100000.0000000000");
    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockImplementation(async () => required);
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-10-12T00:00:00.000Z",
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

  const authorize = (campaignId: string | null, cents: string) => {
    required = cents;
    const headers: Record<string, string> = { ...getAuthHeaders(orgId, userId, runId) };
    if (campaignId) headers["x-campaign-id"] = campaignId;
    return request(app).post("/v1/customer_balance/authorize").set(headers).send(body);
  };
  const readCap = () =>
    request(app)
      .get(`/internal/brands/${brandId}/offers/${OFFER}/sales-funnels/${encodeURIComponent(FUNNEL)}/campaigns/${FC}/caps`)
      .set({ "X-API-Key": "test-api-key", "x-org-id": orgId });

  it("cap 500c, consumed 495c: a 16c spend is REFUSED with the named reason, before any balance logic", async () => {
    mockUpstreams({ spent: { [SOURCE_UNIT]: "495" }, campaignReads: 0, costReads: 0 });
    await stateCap();

    const res = await authorize(SOURCE_UNIT, "16.0000000000");
    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
    expect(res.body.reason).toBe("sales_funnel_max_budget_reached");
    expect(res.body.sales_funnel_cap).toMatchObject({
      salesFunnelId: FUNNEL,
      salesFunnelCampaignId: FC,
      amountCents: "500.0000000000",
      consumedCents: "495.0000000000",
    });
    expect(ss.reloadOffSession).not.toHaveBeenCalled();
    expect(await listEpisodes(orgId)).toHaveLength(0);

    // The caps read now says reached (campaign-service stops dispatching), though 5c remain.
    const cap = await readCap();
    expect(cap.status).toBe(200);
    expect(cap.body.maxBudget.reached).toBe(true);
    expect(cap.body.maxBudget.remainingCents).toBe("5.0000000000");
    expect(cap.body.maxBudget.refusedSpend.requiredCents).toBe("16.0000000000");

    // And every later spend of the funnel campaign is refused for this window, any pipe.
    const later = await authorize(TEAM_UNIT, "1.0000000000");
    expect(later.body.sufficient).toBe(false);
    expect(later.body.reason).toBe("sales_funnel_max_budget_reached");
  });

  it("cap 500c, consumed 495c: a 4c spend PASSES, byte-identical to today's answer", async () => {
    mockUpstreams({ spent: { [SOURCE_UNIT]: "495" }, campaignReads: 0, costReads: 0 });
    await stateCap();

    const res = await authorize(SOURCE_UNIT, "4.0000000000");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["balance_cents", "required_cents", "sufficient"]);
    expect(res.body.sufficient).toBe(true);

    const cap = await readCap();
    expect(cap.body.maxBudget.reached).toBe(false);
    expect(cap.body.maxBudget.refusedSpend).toBeNull();
  });

  it("two concurrent spends of two pipes cannot both slip under the cap", async () => {
    mockUpstreams({ spent: { [SOURCE_UNIT]: "490" }, campaignReads: 0, costReads: 0 });
    await stateCap();
    required = "8.0000000000";
    const send = (campaignId: string) =>
      request(app)
        .post("/v1/customer_balance/authorize")
        .set({ ...getAuthHeaders(orgId, userId, runId), "x-campaign-id": campaignId })
        .send(body);
    const [a, b] = await Promise.all([send(SOURCE_UNIT), send(TEAM_UNIT)]);
    const passed = [a, b].filter((r) => r.body.sufficient === true);
    expect(passed).toHaveLength(1);
    const refused = [a, b].find((r) => r.body.sufficient === false)!;
    expect(refused.body.reason).toBe("sales_funnel_max_budget_reached");
    expect(refused.body.sales_funnel_cap.reservedCents).toBe("8.0000000000");
  });

  it("a campaign of no funnel is byte-identical, and an org with no max budget reads nothing upstream", async () => {
    const u = mockUpstreams({ spent: {}, campaignReads: 0, costReads: 0 });
    const none = await authorize(NOT_A_UNIT, "16.0000000000");
    expect(none.body).toEqual({ sufficient: true, balance_cents: "100000.0000000000", required_cents: "16.0000000000" });
    expect(u.campaignReads).toBe(0);
    expect(u.costReads).toBe(0);

    await stateCap();
    const notUnit = await authorize(NOT_A_UNIT, "16.0000000000");
    expect(notUnit.body).toEqual(none.body);
    const noCampaign = await authorize(null, "16.0000000000");
    expect(noCampaign.body).toEqual(none.body);
  });

  it("our own PLATFORM org's funnel cap still binds (a cap is not a balance question)", async () => {
    await db.insert(platformOrgs).values({ orgId, reason: "test", addedBy: "test" });
    mockUpstreams({ spent: { [SOURCE_UNIT]: "495" }, campaignReads: 0, costReads: 0 });
    await stateCap();

    const refused = await authorize(SOURCE_UNIT, "16.0000000000");
    expect(refused.body.sufficient).toBe(false);
    expect(refused.body.reason).toBe("sales_funnel_max_budget_reached");
  });

  it("a platform org spend with room keeps the platform answer", async () => {
    await db.insert(platformOrgs).values({ orgId, reason: "test", addedBy: "test" });
    mockUpstreams({ spent: { [SOURCE_UNIT]: "10" }, campaignReads: 0, costReads: 0 });
    await stateCap();
    const ok = await authorize(SOURCE_UNIT, "16.0000000000");
    expect(ok.body).toEqual({ sufficient: true, balance_cents: "100000.0000000000", required_cents: "16.0000000000" });
  });

  it("the funnel-wide cap binds a unit whose funnel campaign states none; an own volume-only cap shadows it", async () => {
    mockUpstreams({ spent: { [SOURCE_UNIT]: "495" }, campaignReads: 0, costReads: 0 });
    await stateCap({ own: false });
    const held = await authorize(TEAM_UNIT, "16.0000000000");
    expect(held.body.reason).toBe("sales_funnel_max_budget_reached");
    expect(held.body.sales_funnel_cap.salesFunnelCampaignId).toBeNull();

    await cleanTestData();
    __resetFunnelCapAuthorize();
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 1000 });
    await stateCap({ own: false });
    await stateCap({ budgetCents: null, volume: 1 });
    const own = await authorize(TEAM_UNIT, "16.0000000000");
    expect(own.body.sufficient).toBe(true);
    expect(own.body.reason).toBeUndefined();
  });

  it("a refusal only IN-FLIGHT spends caused holds that spend alone, never the window (2026-10-15)", async () => {
    // One-off $2 cap, 4.6c really consumed. The same run's earlier spends reserved
    // 120c seconds before: a 79c spend does not fit NOW, but 4.6 + 79 < 200.
    mockUpstreams({ spent: { [SOURCE_UNIT]: "4.6" }, campaignReads: 0, costReads: 0 });
    await stateCap({ budgetCents: "200" });
    expect((await authorize(SOURCE_UNIT, "120.0000000000")).body.sufficient).toBe(true);

    const refused = await authorize(TEAM_UNIT, "79.4421000000");
    expect(refused.body.sufficient).toBe(false);
    expect(refused.body.reason).toBe("sales_funnel_max_budget_reached");
    expect(refused.body.sales_funnel_cap.reservedCents).toBe("120.0000000000");

    // Not held: the figure and the verdict agree (4.6 of 200, not reached).
    const [row] = await db.select().from(salesFunnelCaps);
    expect(row.maxBudgetRefusedAt).toBeNull();
    const cap = await readCap();
    expect(cap.body.maxBudget.consumedCents).toBe("4.6000000000");
    expect(cap.body.maxBudget.reached).toBe(false);
    expect(cap.body.maxBudget.refusedSpend).toBeNull();
  });

  it("a recorded refusal the real consumption leaves room for no longer holds the cap", async () => {
    // A latch written before the fix: 79c refused on a 200c one-off with 4.6c consumed.
    mockUpstreams({ spent: { [SOURCE_UNIT]: "4.6" }, campaignReads: 0, costReads: 0 });
    await stateCap({ budgetCents: "200" });
    const [row] = await db.select().from(salesFunnelCaps);
    await db.update(salesFunnelCaps).set({
      maxBudgetRefusedAt: new Date(),
      maxBudgetRefusedCents: "79.4421000000",
      maxBudgetRefusedWindowStart: row.maxBudgetSince,
      maxBudgetRefusedCapCents: "200",
    });

    const cap = await readCap();
    expect(cap.body.maxBudget.reached).toBe(false);
    expect(cap.body.maxBudget.refusedSpend).toBeNull();
    expect((await authorize(SOURCE_UNIT, "79.4421000000")).body.sufficient).toBe(true);
  });

  it("consumption unreadable on a binding cap = refused, named (fail-closed)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mockUpstreams({ spent: {}, costsStatus: 503, campaignReads: 0, costReads: 0 });
    await stateCap();
    const res = await authorize(SOURCE_UNIT, "4.0000000000");
    expect(res.body.sufficient).toBe(false);
    expect(res.body.reason).toBe("sales_funnel_max_budget_unreadable");
    expect(err).toHaveBeenCalled();
  });
});
