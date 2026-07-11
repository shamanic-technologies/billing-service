import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestAccount,
  insertTestCampaignCost,
  listEpisodes,
  closeDb,
} from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";

const orgId = "00000000-0000-0000-0000-00000000c201";
const campaignId = "00000000-0000-0000-0000-0000000ca601";
const unknownCampaignId = "00000000-0000-0000-0000-0000000ca999";

const apiKeyHeaders = { "X-API-Key": "test-api-key" };

function affordabilityPath(id: string) {
  return `/internal/campaigns/${id}/affordability`;
}

describe("GET /internal/campaigns/:campaignId/affordability (read-only gate)", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let setUsage: (cents: string) => void;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@acme.test"));
    await cleanTestData();

    const runsClient = await import("../../src/lib/runs-client.js");
    let usage = "0.0000000000";
    setUsage = (cents: string) => {
      usage = cents;
    };
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage,
      as_of: "2026-06-14T00:00:00.000Z",
    }));
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("no stored cost → first-run default affordable=true, hasHistory=false", async () => {
    const res = await request(app)
      .get(affordabilityPath(unknownCampaignId))
      .set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      affordable: true,
      balanceCents: "0.0000000000",
      lastRequiredCents: null,
      hasHistory: false,
    });
    // Read-only: no downstream balance compose for an unknown campaign.
    expect(ssMocks.fetchOrgCustomer).not.toHaveBeenCalled();
  });

  it("stored cost, live balance >= lastRequired → affordable=true, hasHistory=true", async () => {
    await insertTestCampaignCost({
      campaignId,
      orgId,
      lastAuthorizeRequiredCents: "10.0000000000",
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("100.0000000000");
    setUsage("40.0000000000"); // balance = 100 − 40 = 60 >= 10

    const res = await request(app)
      .get(affordabilityPath(campaignId))
      .set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      affordable: true,
      balanceCents: "60.0000000000",
      lastRequiredCents: "10.0000000000",
      hasHistory: true,
    });
    // User-less balance path: computeBalance reads stripe-service via the
    // org-keyed /internal route — keyed off orgId ONLY, no x-user-id/sentinel.
    expect(ssMocks.fetchOrgCustomer).toHaveBeenCalledWith(orgId);
  });

  it("stored cost, live balance < lastRequired → affordable=false", async () => {
    await insertTestCampaignCost({
      campaignId,
      orgId,
      lastAuthorizeRequiredCents: "50.0000000000",
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("100.0000000000");
    setUsage("90.0000000000"); // balance = 100 − 90 = 10 < 50

    const res = await request(app)
      .get(affordabilityPath(campaignId))
      .set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.affordable).toBe(false);
    expect(res.body.balanceCents).toBe("10.0000000000");
    expect(res.body.lastRequiredCents).toBe("50.0000000000");
    expect(res.body.hasHistory).toBe(true);
  });

  it("postpaid org: balance negative but within the credit line → affordable=true", async () => {
    // Auto-topup enabled + chargeable card + non-blocked country ⇒ postpaid line.
    // Start tier (paid < $200) → floor −$50 (−5000 cents).
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 200 });
    await insertTestCampaignCost({
      campaignId,
      orgId,
      lastAuthorizeRequiredCents: "10.0000000000",
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("100.0000000000"); // paid → start tier
    setUsage("150.0000000000"); // balance = 100 − 150 = −50 cents, well within the −5000 floor

    const res = await request(app)
      .get(affordabilityPath(campaignId))
      .set(apiKeyHeaders);

    expect(res.status).toBe(200);
    // balance − required = −60 >= floor −5000 → affordable, even though balance < 0
    // (and < required, which would have blocked under the old zero-floor gate).
    expect(res.body.affordable).toBe(true);
    expect(res.body.balanceCents).toBe("-50.0000000000");
    expect(res.body.lastRequiredCents).toBe("10.0000000000");
    expect(res.body.hasHistory).toBe(true);
  });

  it("postpaid org: next run would cross past the floor → affordable=false", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 200 });
    await insertTestCampaignCost({
      campaignId,
      orgId,
      lastAuthorizeRequiredCents: "10.0000000000",
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("5.0000000000"); // start tier, floor −5000
    setUsage("5000.0000000000"); // balance = 5 − 5000 = −4995 cents (just inside the floor)

    const res = await request(app)
      .get(affordabilityPath(campaignId))
      .set(apiKeyHeaders);

    expect(res.status).toBe(200);
    // balance − required = −5005 < floor −5000 → running it crosses the line.
    expect(res.body.affordable).toBe(false);
    expect(res.body.balanceCents).toBe("-4995.0000000000");
  });

  it("zero-floor org (no auto-topup config): unchanged — negative balance is not affordable", async () => {
    // Same negative balance as the within-line case, but WITHOUT a postpaid line
    // (no topup config ⇒ floor "0") → blocks once it can't cover the run.
    await insertTestCampaignCost({
      campaignId,
      orgId,
      lastAuthorizeRequiredCents: "10.0000000000",
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("100.0000000000");
    setUsage("150.0000000000"); // balance = −50 cents; no credit line

    const res = await request(app)
      .get(affordabilityPath(campaignId))
      .set(apiKeyHeaders);

    expect(res.status).toBe(200);
    // balance − required = −60 < floor 0 → not affordable.
    expect(res.body.affordable).toBe(false);
    expect(res.body.balanceCents).toBe("-50.0000000000");
  });

  it("postpaid org with a reload-blocked card country (India): no line → floor 0", async () => {
    // Auto-topup config present but the card can't be charged off_session (e.g.
    // India / RBI) ⇒ no effective credit line (floor "0"), same as authorize.
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 200 });
    await insertTestCampaignCost({
      campaignId,
      orgId,
      lastAuthorizeRequiredCents: "10.0000000000",
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("100.0000000000");
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("IN");
    setUsage("150.0000000000"); // balance = −50 cents

    const res = await request(app)
      .get(affordabilityPath(campaignId))
      .set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.affordable).toBe(false);
    expect(res.body.balanceCents).toBe("-50.0000000000");
  });

  it("is read-only: never reloads or opens a depletion episode even when depleted", async () => {
    await insertTestCampaignCost({
      campaignId,
      orgId,
      lastAuthorizeRequiredCents: "50.0000000000",
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    setUsage("100.0000000000"); // balance = −100, depleted

    const res = await request(app)
      .get(affordabilityPath(campaignId))
      .set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.affordable).toBe(false);
    expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
    expect(await listEpisodes(orgId)).toHaveLength(0);
  });

  it("fails loud (502) when runs-service is unreachable and history exists", async () => {
    await insertTestCampaignCost({
      campaignId,
      orgId,
      lastAuthorizeRequiredCents: "10.0000000000",
    });
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockRejectedValue(
      new Error("runs-service down")
    );

    const res = await request(app)
      .get(affordabilityPath(campaignId))
      .set(apiKeyHeaders);

    expect(res.status).toBe(502);
  });

  it("rejects a non-UUID campaignId with 400", async () => {
    const res = await request(app)
      .get(affordabilityPath("not-a-uuid"))
      .set(apiKeyHeaders);

    expect(res.status).toBe(400);
  });

  it("requires service auth (401 without x-api-key)", async () => {
    const res = await request(app).get(affordabilityPath(campaignId));
    expect(res.status).toBe(401);
  });
});
