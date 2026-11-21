/**
 * DISTRY-CALL-IS-CAMPAIGN-1121 (owner 2026-11-21): every Distry call to an Engine is a campaign, and a
 * campaign may name NO offer ("check this email address", "draft a newsletter"). Its caps are stored,
 * read, funded and enforced exactly like a campaign naming an offer, on the offer-less routes
 * (`/brands/:b/sales-funnels/:f/...`, offerId null). The same suite runs with an offer: unchanged.
 *
 * Own file (CLAUDE.md: one describe per file that closes the DB).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { __resetSalesFunnelCache } from "../../src/lib/sales-funnel-catalogue.js";
import { __primeSalesPathTerms, __resetSalesPathTerms } from "../../src/lib/sales-path-terms.js";
import { __primeOutcomeSteps, __resetOutcomeSteps } from "../../src/lib/outcome-steps.js";
import { __resetStepEvidence } from "../../src/lib/sales-funnel-caps.js";
import { __resetFunnelCapAuthorize } from "../../src/lib/funnel-cap-authorize.js";

const orgId = "00000000-0000-4000-8000-000000112101";
const userId = "00000000-0000-4000-8000-000000112109";
const runId = "00000000-0000-4000-8000-00000011210a";
const brandId = "00000000-0000-4000-8000-000000112111";
const OFFER = "aaaaaaaa-1121-4121-8121-aaaaaaaaaaaa";
const TARGET = "newsletter_drafted";
const FC = "44444444-0000-4000-8000-000000000001";
const UNIT = "44444444-0000-4000-8000-000000000002";
const OTHER = "44444444-0000-4000-8000-000000000003";

const app = createTestApp();
const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const occurrence = (campaignId: string) => ({
  id: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  direction: "produced",
  outcomeKey: TARGET,
  quantity: "1.000000",
  tags: { brandIds: [brandId], campaignId, workflowSlug: null, featureSlug: null, audienceId: null },
});

/** The upstreams of one campaign launched on its target, naming `offerId` (null = no offer). */
function mockUpstreams(offerId: string | null, state: { spentCents: string; earned: number }) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (/^\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) return Response.json({ ok: true });
    if (url.pathname.startsWith("/internal/catalogue/sales-funnels/")) {
      return Response.json({ reason: "sales_funnel_not_found" }, { status: 404 });
    }
    if (url.pathname === "/sales-funnel-campaigns") {
      return Response.json({
        salesFunnelCampaigns: [
          {
            id: FC,
            orgId,
            brandId,
            offerId,
            salesFunnelId: TARGET,
            salesFunnelName: null,
            name: "Draft the newsletter",
            target: TARGET,
            status: "ongoing",
            units: [{ campaignId: UNIT, featureSlug: null, legKey: null, status: "ongoing", workflowSlug: `engine:${TARGET}` }],
          },
        ],
      });
    }
    if (url.pathname === "/internal/campaigns/recurring-status") {
      return Response.json({
        campaigns: [
          {
            campaignId: UNIT,
            orgId,
            brandId,
            offerId,
            featureSlug: null,
            legKey: null,
            status: "ongoing",
            running: true,
            executedByPlatform: true,
            kind: "proactive",
            audience: "available",
            allAudiencesExhausted: false,
            recurring: true,
          },
        ],
      });
    }
    if (url.pathname === "/v1/stats/costs") {
      return Response.json({
        groups: url.searchParams
          .get("campaignIds")!
          .split(",")
          .map((id) => ({ dimensions: { campaignId: id }, netTotalCostInUsdCents: id === UNIT ? state.spentCents : "999" })),
      });
    }
    if (url.pathname === "/internal/outcome-occurrences") {
      if (!url.searchParams.get("orgId")) return Response.json({ occurrences: [occurrence(OTHER)], nextCursor: null });
      return Response.json({
        occurrences: [...Array.from({ length: state.earned }, () => occurrence(UNIT)), occurrence(OTHER)],
        nextCursor: null,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe("caps of a campaign naming no offer, and the same with an offer", () => {
  const savedEnv = { ...process.env };
  let required = "1.0000000000";

  beforeAll(() => {
    process.env.FEATURES_SERVICE_API_KEY = "test-features-key";
    process.env.CAMPAIGN_SERVICE_URL = "http://localhost:9994";
    process.env.CAMPAIGN_SERVICE_API_KEY = "test-campaign-key";
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    __resetSalesFunnelCache();
    __resetStepEvidence();
    __resetFunnelCapAuthorize();
    __primeSalesPathTerms([], { sourceLegKey: "start_to_lead_found", origins: [], originsByChannel: {} } as never);
    // Its target is about an OBJECT: it counts the outcomes it produced (OUTREACH-3WAYS-1121 leaves it unchanged).
    __primeOutcomeSteps([{ key: "newsletter_drafted", lifecycleRung: "none", subjectKind: "object" }, { key: "message_sent", lifecycleRung: "contacted", subjectKind: "person" }]);
    const ss = setupStripeMocks();
    ss.sumSucceededTopupsForOrg.mockResolvedValue("100000.0000000000");
    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockImplementation(async () => required);
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-11-21T00:00:00.000Z",
    });
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 1000 });
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

  const authorize = (cents: string) => {
    required = cents;
    return request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId, userId, runId), "x-campaign-id": UNIT })
      .send({ items: [{ costName: "anthropic-sonnet-input", quantity: 1 }], description: "draft" });
  };

  for (const offerId of [null, OFFER]) {
    const label = offerId ? "with an offer" : "with NO offer";
    const campaignPath = `/brands/${brandId}${offerId ? `/offers/${offerId}` : ""}/sales-funnels/${TARGET}/campaigns/${FC}/caps`;
    const put = () =>
      request(app)
        .put(`/internal${campaignPath}`)
        .set(internal)
        .send({ maxBudget: { amountCents: 100, period: "one_off" }, maxVolume: { count: 1, period: "one_off" } });
    const read = () => request(app).get(`/internal${campaignPath}`).set(internal);

    it(`${label}: one-off $1 + max volume 1 is funded, consumed, then reached`, async () => {
      const state = { spentCents: "0", earned: 0 };
      mockUpstreams(offerId, state);
      const res = await put();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ offerId, capScope: "sales_funnel_campaign", stated: true, funded: true, fundedBy: "both" });

      let r = await read();
      expect(r.body.maxBudget).toMatchObject({ period: "one_off", consumedCents: "0.0000000000", reached: false, consumedUnavailableReason: null });
      expect(r.body.maxVolume).toMatchObject({ unit: "outcomes_produced", consumed: 0, remaining: 1, reached: false });

      state.spentCents = "100";
      state.earned = 1;
      __resetFunnelCapAuthorize();
      r = await read();
      expect(r.body.maxBudget).toMatchObject({ consumedCents: "100.0000000000", remainingCents: "0.0000000000", reached: true });
      expect(r.body.maxVolume).toMatchObject({ consumed: 1, remaining: 0, reached: true });

      // The brand list states it with its offer, or with none.
      const list = await request(app).get(`/internal/brands/${brandId}/sales-funnel-caps`).set(internal);
      expect(list.body.caps).toEqual([expect.objectContaining({ offerId, salesFunnelId: TARGET, salesFunnelCampaignId: FC, funded: true })]);
    });

    it(`${label}: authorize refuses a spend past the $1, lets one under it through`, async () => {
      mockUpstreams(offerId, { spentCents: "95", earned: 0 });
      expect((await put()).status).toBe(200);

      const under = await authorize("4.0000000000");
      expect(under.body.sufficient).toBe(true);

      const past = await authorize("10.0000000000");
      expect(past.body.sufficient).toBe(false);
      expect(past.body.reason).toBe("sales_funnel_max_budget_reached");
      expect(past.body.sales_funnel_cap).toMatchObject({ salesFunnelId: TARGET, salesFunnelCampaignId: FC, amountCents: "100.0000000000" });
    });

    it(`${label}: the other shape of the key does not hold this campaign`, async () => {
      mockUpstreams(offerId, { spentCents: "0", earned: 0 });
      const otherPath = `/brands/${brandId}${offerId ? "" : `/offers/${OFFER}`}/sales-funnels/${TARGET}/campaigns/${FC}/caps`;
      // No campaign launched on this target carries the other offer key: nothing to cap there.
      const res = await request(app).put(`/internal${otherPath}`).set(internal).send({ maxBudget: { amountCents: 100, period: "one_off" }, maxVolume: null });
      expect(res.status).toBe(404);
      expect(res.body.reason).toBe("sales_funnel_not_found");
      // And the campaign's own key still states nothing.
      expect((await read()).body.stated).toBe(false);
    });
  }
});
