import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import {
  cleanTestData,
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
    ssMocks.getCustomerByOrg.mockResolvedValue(customerWithEmail("founder@acme.test"));
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
    expect(ssMocks.getCustomerByOrg).not.toHaveBeenCalled();
  });

  it("stored cost, live balance >= lastRequired → affordable=true, hasHistory=true", async () => {
    await insertTestCampaignCost({
      campaignId,
      orgId,
      lastAuthorizeRequiredCents: "10.0000000000",
    });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("100.0000000000");
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
    // Regression: stripe-service requires x-user-id on GET /v1/customers; the
    // identity built from the stored row MUST carry it (else prod 400 → 502).
    expect(ssMocks.getCustomerByOrg).toHaveBeenCalledWith(
      expect.objectContaining({
        "x-org-id": orgId,
        "x-user-id": expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        ),
      })
    );
  });

  it("stored cost, live balance < lastRequired → affordable=false", async () => {
    await insertTestCampaignCost({
      campaignId,
      orgId,
      lastAuthorizeRequiredCents: "50.0000000000",
    });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("100.0000000000");
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

  it("is read-only: never reloads or opens a depletion episode even when depleted", async () => {
    await insertTestCampaignCost({
      campaignId,
      orgId,
      lastAuthorizeRequiredCents: "50.0000000000",
    });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");
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
