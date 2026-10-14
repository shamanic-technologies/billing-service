/**
 * MAX BUDGET + MAX VOLUME of ONE sales funnel CAMPAIGN (migration 0083): several
 * funnel campaigns share one funnel (the Copilot's person-targeted follow-ups,
 * Marie's and Paul's both on "follow_up_due -> AI Follow-up Email"), each holds
 * its own cap, consumed on its own units only. The funnel-wide cap is untouched.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { salesFunnelCapChanges, salesFunnelCaps, type SalesFunnelCapRow } from "../../src/db/schema.js";
import { __resetSalesFunnelCache } from "../../src/lib/sales-funnel-catalogue.js";
import { __primeSalesPathTerms, __resetSalesPathTerms } from "../../src/lib/sales-path-terms.js";
import { capOfFunnelCampaign } from "../../src/lib/funnel-campaigns.js";

const orgId = "00000000-0000-0000-0000-0000000083a1";
const userId = "00000000-0000-0000-0000-0000000083a9";
const runId = "00000000-0000-0000-0000-0000000083ab";
const brandId = "00000000-0000-0000-0000-000000083b01";
const OFFER = "aaaaaaaa-1183-4183-8183-aaaaaaaaaaaa";

const FOLLOW = "ai-follow-up-email";
const FUNNEL = "signup_to_paid_client@ai-follow-up-email";
const FC_MARIE = "cccccccc-0000-4000-8000-00000000000a";
const FC_PAUL = "cccccccc-0000-4000-8000-00000000000b";
const FC_UNKNOWN = "cccccccc-0000-4000-8000-00000000000f";
const UNIT_MARIE = "11111111-0000-4000-8000-0000000000a1";
const UNIT_PAUL = "11111111-0000-4000-8000-0000000000b1";

const app = createTestApp();
const auth = getAuthHeaders(orgId, userId, runId);
const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const funnelPath = `/brands/${brandId}/offers/${OFFER}/sales-funnels/${encodeURIComponent(FUNNEL)}/caps`;
const campaignPath = (fc: string) =>
  `/brands/${brandId}/offers/${OFFER}/sales-funnels/${encodeURIComponent(FUNNEL)}/campaigns/${fc}/caps`;

const unit = (campaignId: string) => ({
  campaignId,
  orgId,
  brandId,
  offerId: OFFER,
  featureSlug: FOLLOW,
  legKey: "signup_to_paid_client",
  status: "ongoing",
  running: true,
  executedByPlatform: true,
  kind: "reactive",
  audience: "available",
  allAudiencesExhausted: false,
  recurring: true,
});

interface Calls {
  outcomes: URLSearchParams[];
  costs: URLSearchParams[];
}

/** Emails sent so far, per unit campaign (one `email-send-step-1` run each). */
function mockUpstreams(sent: Record<string, number>): Calls {
  const calls: Calls = { outcomes: [], costs: [] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/internal/catalogue/sales-funnels/")) {
      return Response.json({
        object: "sales_funnel",
        id: FUNNEL,
        name: "Follow-up",
        type: "reactive",
        legs: [{ legKey: "signup_to_paid_client", pipe: { id: `${FOLLOW}|signup_to_paid_client`, mode: "reactive" } }],
      });
    }
    if (url.pathname === "/internal/campaigns/recurring-status") {
      return Response.json({ campaigns: [unit(UNIT_MARIE), unit(UNIT_PAUL)] });
    }
    if (url.pathname === "/sales-funnel-campaigns") {
      const fc = (id: string, u: string) => ({
        id,
        brandId,
        offerId: OFFER,
        salesFunnelId: FUNNEL,
        salesFunnelName: "Follow-up",
        status: "ongoing",
        units: [{ campaignId: u, featureSlug: FOLLOW, legKey: "signup_to_paid_client", status: "ongoing" }],
      });
      return Response.json({ salesFunnelCampaigns: [fc(FC_MARIE, UNIT_MARIE), fc(FC_PAUL, UNIT_PAUL)] });
    }
    if (url.pathname === "/v1/stats/run-outcomes") {
      calls.outcomes.push(url.searchParams);
      return Response.json({
        scope: "all",
        groups: url.searchParams
          .get("campaignIds")!
          .split(",")
          .map((id) => ({ dimensions: { campaignId: id }, completedCount: sent[id] ?? 0, runningCount: 0 })),
      });
    }
    if (url.pathname === "/v1/stats/costs") {
      calls.costs.push(url.searchParams);
      return Response.json({
        groups: url.searchParams
          .get("campaignIds")!
          .split(",")
          .map((id) => ({ dimensions: { campaignId: id }, netTotalCostInUsdCents: sent[id] ? "12.5" : "0" })),
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

const putCampaign = (fc: string, body: unknown, internalRoute = true) =>
  internalRoute
    ? request(app).put(`/internal${campaignPath(fc)}`).set({ ...internal, "x-user-id": userId }).send(body as object)
    : request(app).put(`/v1${campaignPath(fc)}`).set(auth).send(body as object);
const readCampaign = (fc: string) => request(app).get(`/internal${campaignPath(fc)}`).set(internal);
const ONE_EMAIL = { maxBudget: null, maxVolume: { count: 1, period: "one_off" } };

describe("sales funnel campaign caps", () => {
  const savedEnv = { ...process.env };
  beforeAll(() => {
    process.env.FEATURES_SERVICE_API_KEY = "test-features-key";
    process.env.CAMPAIGN_SERVICE_URL = "http://localhost:9994";
    process.env.CAMPAIGN_SERVICE_API_KEY = "test-campaign-key";
  });
  beforeEach(async () => {
    await cleanTestData();
    __resetSalesFunnelCache();
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

  it("two funnel campaigns on one funnel, max volume 1 each: after Marie's email Marie is reached, Paul still has room", async () => {
    const calls = mockUpstreams({ [UNIT_MARIE]: 1 });
    expect((await putCampaign(FC_MARIE, ONE_EMAIL)).status).toBe(200);
    expect((await putCampaign(FC_PAUL, ONE_EMAIL)).status).toBe(200);

    // Two rows, neither overwrote the other, and no funnel-wide cap was written.
    const rows = await db.select().from(salesFunnelCaps);
    expect(rows.map((r) => r.salesFunnelCampaignId).sort()).toEqual([FC_MARIE, FC_PAUL]);

    const marie = (await readCampaign(FC_MARIE)).body;
    expect(marie.capScope).toBe("sales_funnel_campaign");
    expect(marie.salesFunnelCampaignId).toBe(FC_MARIE);
    expect(marie.funded).toBe(true);
    expect(marie.fundedBy).toBe("max_volume");
    expect(marie.volumeUnit).toBe("prospects_handled");
    expect(marie.pipes[0].campaignIds).toEqual([UNIT_MARIE]);
    expect(marie.maxVolume).toMatchObject({ count: 1, unit: "prospects_handled", consumed: 1, remaining: 0, reached: true, consumedUnavailableReason: null });

    const paul = (await readCampaign(FC_PAUL)).body;
    expect(paul.pipes[0].campaignIds).toEqual([UNIT_PAUL]);
    expect(paul.maxVolume).toMatchObject({ consumed: 0, remaining: 1, reached: false, consumedUnavailableReason: null });

    // Measured on the email-send run, one per person, on that campaign's unit only.
    const last = calls.outcomes.at(-1)!;
    expect(last.get("serviceName")).toBe("instantly-service");
    expect(last.get("taskName")).toBe("email-send-step-1");
    expect(last.get("campaignIds")).toBe(UNIT_PAUL);

    // The funnel-wide read is unchanged: nothing stated there.
    const funnel = await request(app).get(`/internal${funnelPath}`).set(internal);
    expect(funnel.body.stated).toBe(false);
    expect(funnel.body.capScope).toBeUndefined();
  });

  it("a funnel-wide max volume 1 on ai-follow-up-email reads reached after one send (measured, not null)", async () => {
    mockUpstreams({ [UNIT_MARIE]: 1 });
    const res = await request(app).put(`/v1${funnelPath}`).set(auth).send(ONE_EMAIL);
    expect(res.status).toBe(200);
    expect(res.body.maxVolume).toMatchObject({ unit: "prospects_handled", consumed: 1, reached: true, consumedUnavailableReason: null });
  });

  it("a funnel campaign with no cap of its own is held to the funnel-wide cap, figures identical to the funnel read", async () => {
    mockUpstreams({ [UNIT_MARIE]: 1 });
    await request(app).put(`/v1${funnelPath}`).set(auth).send({ maxBudget: { amountCents: 500, period: "daily" }, maxVolume: { count: 3, period: "daily" } });
    const funnel = (await request(app).get(`/internal${funnelPath}`).set(internal)).body;
    const paul = (await readCampaign(FC_PAUL)).body;
    expect(paul.capScope).toBe("sales_funnel");
    const { capScope, salesFunnelCampaignId, ...rest } = paul;
    expect(salesFunnelCampaignId).toBe(FC_PAUL);
    expect(rest).toEqual(funnel);
  });

  it("its own cap wins over the funnel-wide one, and clearing it falls back without touching the funnel-wide row", async () => {
    mockUpstreams({});
    await request(app).put(`/v1${funnelPath}`).set(auth).send({ maxBudget: null, maxVolume: { count: 50, period: "monthly" } });
    await putCampaign(FC_MARIE, ONE_EMAIL, false);
    expect((await readCampaign(FC_MARIE)).body.maxVolume.count).toBe(1);

    const cleared = await request(app).delete(`/internal${campaignPath(FC_MARIE)}`).set(internal);
    expect(cleared.status).toBe(200);
    expect(cleared.body.capScope).toBe("sales_funnel");
    expect(cleared.body.maxVolume.count).toBe(50);
    const rows = await db.select().from(salesFunnelCaps);
    expect(rows).toHaveLength(1);
    expect(rows[0].salesFunnelCampaignId).toBeNull();
    const history = await db.select().from(salesFunnelCapChanges);
    expect(history.filter((h) => h.salesFunnelCampaignId === FC_MARIE)).toHaveLength(2);
  });

  it("a funnel campaign campaign-service does not state: consumed null with a named reason, never 0", async () => {
    mockUpstreams({});
    await putCampaign(FC_UNKNOWN, ONE_EMAIL);
    const b = (await readCampaign(FC_UNKNOWN)).body;
    expect(b.capScope).toBe("sales_funnel_campaign");
    expect(b.maxVolume).toMatchObject({ consumed: null, reached: null, consumedUnavailableReason: "sales_funnel_campaign_not_found" });
  });

  it("the brand list names which cap is a funnel campaign's", async () => {
    mockUpstreams({});
    await putCampaign(FC_MARIE, ONE_EMAIL);
    await request(app).put(`/v1${funnelPath}`).set(auth).send(ONE_EMAIL);
    const list = (await request(app).get(`/internal/brands/${brandId}/sales-funnel-caps`).set(internal)).body;
    const ids = list.caps.map((c: { salesFunnelCampaignId?: string }) => c.salesFunnelCampaignId ?? "funnel-wide");
    expect(ids.sort()).toEqual([FC_MARIE, "funnel-wide"].sort());
    expect(list.caps.find((c: { salesFunnelCampaignId?: string }) => !c.salesFunnelCampaignId)).not.toHaveProperty("salesFunnelCampaignId");
  });

  it("refuses a bad funnel campaign id and the retired replacesCeilings field", async () => {
    mockUpstreams({});
    expect((await readCampaign("not-a-uuid")).status).toBe(400);
    const conv = await putCampaign(FC_MARIE, { ...ONE_EMAIL, replacesCeilings: [{ featureSlug: FOLLOW, legKey: "signup_to_paid_client" }] });
    expect(conv.status).toBe(400);
    expect(await db.select().from(salesFunnelCaps)).toHaveLength(0);
  });

  it("capOfFunnelCampaign: the campaign's own cap, else the funnel-wide one", () => {
    const row = (fc: string | null, maxVolume: number) =>
      ({ orgId, brandId, offerId: OFFER, salesFunnelId: FUNNEL, salesFunnelCampaignId: fc, maxVolume }) as unknown as SalesFunnelCapRow;
    const caps = [row(null, 50), row(FC_MARIE, 1)];
    const fc = (id: string) => ({ id, brandId, offerId: OFFER, salesFunnelId: FUNNEL });
    expect(capOfFunnelCampaign(caps, fc(FC_MARIE))?.maxVolume).toBe(1);
    expect(capOfFunnelCampaign(caps, fc(FC_PAUL))?.maxVolume).toBe(50);
    expect(capOfFunnelCampaign([row(FC_MARIE, 1)], fc(FC_PAUL))).toBeNull();
  });
});
