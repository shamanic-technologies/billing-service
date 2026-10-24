/**
 * The caps read and authorize never wait on features-service for a funnel billing
 * has already read once (CAPS-READ-FEATURES-DOWN-1024). Prod 2026-10-24: features-
 * service at 85% CPU timed out the live funnel read on every cache miss, campaign-
 * service held AscendQE and CeXO AI all day (fail-closed) while both were funded.
 *
 * Own file (CLAUDE.md: one describe per file that closes the DB).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { featuresCatalogueSnapshots, salesFunnelCaps } from "../../src/db/schema.js";
import { __resetSalesFunnelCache, getSalesFunnel, SalesFunnelCatalogueUnavailableError } from "../../src/lib/sales-funnel-catalogue.js";
import { __primeSalesPathTerms, __resetSalesPathTerms, getSalesPathTerms } from "../../src/lib/sales-path-terms.js";
import { __resetFunnelCapAuthorize } from "../../src/lib/funnel-cap-authorize.js";

const orgId = "00000000-0000-0000-0000-0000000091a1";
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
  /** features-service catalogue: every read times out (slow or redeploying). */
  featuresDown?: boolean;
  catalogueReads: number;
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
      u.catalogueReads += 1;
      if (u.featuresDown) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
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

describe("a funnel read once never waits on features-service again", () => {
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
      as_of: "2026-10-24T00:00:00.000Z",
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

  const authorize = (campaignId: string, cents: string) => {
    required = cents;
    return request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId, userId, runId), "x-campaign-id": campaignId })
      .send(body);
  };
  const readCap = () =>
    request(app)
      .get(`/internal/brands/${brandId}/offers/${OFFER}/sales-funnels/${encodeURIComponent(FUNNEL)}/campaigns/${FC}/caps`)
      .set({ "X-API-Key": "test-api-key", "x-org-id": orgId });

  it("read once, then features-service down AND billing restarted: caps read answers and authorize passes", async () => {
    const u = mockUpstreams({ spent: { [SOURCE_UNIT]: "300" }, catalogueReads: 0, campaignReads: 0, costReads: 0 });
    await stateCap();
    const first = await readCap();
    expect(first.status).toBe(200);
    expect(first.body.maxBudget.consumedCents).toBe("300.0000000000");
    expect(u.catalogueReads).toBe(1);
    expect(await db.select().from(featuresCatalogueSnapshots)).toHaveLength(1);

    // Restart: memory gone, only the persisted snapshot left. features-service times out.
    __resetSalesFunnelCache();
    __resetFunnelCapAuthorize();
    u.featuresDown = true;

    const cap = await readCap();
    expect(cap.status).toBe(200);
    expect(cap.body.maxBudget).toMatchObject({
      consumedCents: "300.0000000000",
      remainingCents: "200.0000000000",
      reached: false,
      consumedUnavailableReason: null,
    });
    expect(cap.body.salesFunnelType).toBe("proactive");

    const res = await authorize(SOURCE_UNIT, "16.0000000000");
    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);

    // The cap still binds on the stored definition: a spend past it is refused.
    const over = await authorize(TEAM_UNIT, "250.0000000000");
    expect(over.body.sufficient).toBe(false);
    expect(over.body.reason).toBe("sales_funnel_max_budget_reached");
  });

  it("memory older than its 5 minutes and features-service down: served at once, refreshed in the background", async () => {
    const u = mockUpstreams({ spent: {}, catalogueReads: 0, campaignReads: 0, costReads: 0 });
    const fresh = await getSalesFunnel(FUNNEL);
    u.featuresDown = true;
    const later = Date.now() + 10 * 60_000;
    const stale = await getSalesFunnel(FUNNEL, later);
    expect(stale).toEqual(fresh);
    await new Promise((r) => setTimeout(r, 20));
    expect(u.catalogueReads).toBe(2);
    // The failed refresh is not retried on every read (one attempt per 5 min).
    await getSalesFunnel(FUNNEL, later + 1_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(u.catalogueReads).toBe(2);
  });

  it("a funnel NEVER read, features-service down: still fail-closed (caps unmeasured, authorize refused)", async () => {
    const u = mockUpstreams({ spent: { [SOURCE_UNIT]: "300" }, featuresDown: true, catalogueReads: 0, campaignReads: 0, costReads: 0 });
    await stateCap();
    await expect(getSalesFunnel(FUNNEL)).rejects.toBeInstanceOf(SalesFunnelCatalogueUnavailableError);
    __resetSalesFunnelCache();
    const cap = await readCap();
    expect(cap.status).toBe(200);
    expect(cap.body.maxBudget.consumedCents).toBeNull();
    expect(cap.body.maxBudget.consumedUnavailableReason).toBe("sales_funnel_catalogue_unavailable");
    const res = await authorize(SOURCE_UNIT, "16.0000000000");
    expect(res.body.sufficient).toBe(false);
    expect(res.body.reason).toBe("sales_funnel_max_budget_unreadable");
    expect(u.catalogueReads).toBeGreaterThan(0);
  });

  it("sourcing terms read once, then features-service down after a restart: served from the snapshot", async () => {
    __resetSalesPathTerms();
    const origins = { sourceLegKey: "start_to_lead_found", origins: [{ slug: SOURCE }], originsByChannel: { "cold-email-outreach": [SOURCE] } };
    let down = false;
    let reads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      reads += 1;
      if (down) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (url.pathname === "/public/channels") return Response.json({ channels: [] });
      if (url.pathname === "/public/sourcing-origins") return Response.json(origins);
      throw new Error(`unexpected fetch ${url}`);
    });
    const first = await getSalesPathTerms();
    expect(first.originsFeeding("cold-email-outreach")).toEqual([SOURCE]);
    __resetSalesPathTerms();
    down = true;
    const readsBefore = reads;
    const again = await getSalesPathTerms();
    expect(again.originsFeeding("cold-email-outreach")).toEqual([SOURCE]);
    expect(again.isSourceItem(SOURCE, "start_to_lead_found")).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(reads).toBeGreaterThan(readsBefore); // background refresh tried, did not block
  });
});
