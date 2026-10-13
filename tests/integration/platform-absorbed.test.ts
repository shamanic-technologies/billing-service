/**
 * Google-Ads billing (owner 2026-10-13): the customer pays what its CAMPAIGNS
 * spend, nothing else. A campaign spending $10 and a $0.40 Copilot chat the same
 * day move the balance by $10; the chat is a cost the platform absorbs, still in
 * runs-service's cost records.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { _resetCoalescer } from "../../src/lib/reload-coalescer.js";
import { PLATFORM_ABSORBS_NO_CAMPAIGN_SINCE_ISO } from "../../src/lib/platform-absorbed.js";

const orgId = "00000000-0000-0000-0000-0000000008a1";
const campaignId = "00000000-0000-0000-0000-0000000008c1";

describe("platform-absorbed spend: only campaign spend is charged", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let noCampaignSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    _resetCoalescer();
    await cleanTestData();
    await insertTestAccount({ orgId });

    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("a@b.test"));
    ssMocks.getCustomerByOrg.mockResolvedValue(customerWithEmail("a@b.test"));
    // $20 paid in.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("2000.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);

    const runsClient = await import("../../src/lib/runs-client.js");
    // runs-service: $10 of campaign spend + $0.40 of Copilot chat = $10.40 total.
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "1040.0000000000",
      as_of: "2026-10-13T00:00:00.000Z",
    });
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({ spent_cents: "1040.0000000000" });
    noCampaignSpy = vi.spyOn(runsClient, "fetchRunsOrgNoCampaignTotal").mockResolvedValue({
      usageNetCents: "40.0000000000",
      actualNetCents: "40.0000000000",
    });
    const costs = await import("../../src/lib/costs-client.js");
    vi.spyOn(costs, "resolveRequiredCents").mockResolvedValue("50.0000000000");
  });

  afterAll(async () => {
    await closeDb();
  });

  it("the balance moves by the campaign spend only, and the absorbed chat is asked from the cutover", async () => {
    const res = await request(app).get("/internal/accounts/by-org/" + orgId + "/balance").set({ "X-API-Key": "test-api-key" });
    expect(res.status).toBe(200);
    // $20 paid − $10 campaign = $10 (the $0.40 chat is the platform's).
    expect(Number(res.body.balance_cents)).toBe(1000);
    expect(Number(res.body.actual_balance_cents)).toBe(1000);
    expect(noCampaignSpy).toHaveBeenCalledWith(orgId, PLATFORM_ABSORBS_NO_CAMPAIGN_SINCE_ISO, expect.anything());
  });

  it("a spend naming no campaign is always sufficient, charges nothing, even out of credit", async () => {
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId))
      .send({ items: [{ costName: "chat", quantity: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("a campaign spend out of credit is still refused", async () => {
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId), "x-campaign-id": campaignId })
      .send({ items: [{ costName: "x", quantity: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
  });

  it("runs-service unable to split fails loud, never reads as nothing absorbed", async () => {
    noCampaignSpy.mockRejectedValue(new Error("runs-service org-no-campaign-total failed: 500"));
    const res = await request(app).get("/internal/accounts/by-org/" + orgId + "/balance").set({ "X-API-Key": "test-api-key" });
    expect(res.status).toBe(502);
  });
});
