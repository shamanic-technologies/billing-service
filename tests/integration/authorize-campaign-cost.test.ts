import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestAccount,
  getCampaignCost,
  closeDb,
} from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

const orgId = "00000000-0000-0000-0000-00000000c101";
const userId = "00000000-0000-0000-0000-000000000099";
const campaignId = "00000000-0000-0000-0000-0000000ca501";

const authorizeBody = {
  items: [{ costName: "anthropic-sonnet-4-5-tokens-input", quantity: 1000 }],
  description: "campaign-cost upsert test",
};

function campaignHeaders() {
  return { ...getAuthHeaders(orgId, userId), "x-campaign-id": campaignId };
}

describe("authorize upserts campaign_authorize_costs when x-campaign-id present", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let setRequired: (cents: string) => void;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();

    const costsClient = await import("../../src/lib/costs-client.js");
    let required = "10.0000000000";
    setRequired = (cents: string) => {
      required = cents;
    };
    vi.spyOn(costsClient, "resolveRequiredCents").mockImplementation(
      async () => required
    );

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-06-14T00:00:00.000Z",
    });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("sufficient outcome → upserts the resolved required_cents with org_id", async () => {
    await insertTestAccount({ orgId });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("1000.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(campaignHeaders())
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);

    const row = await getCampaignCost(campaignId);
    expect(row).not.toBeNull();
    expect(row?.orgId).toBe(orgId);
    expect(row?.lastAuthorizeRequiredCents).toBe("10.0000000000");
  });

  it("insufficient outcome (no topup config) → still upserts the required_cents", async () => {
    await insertTestAccount({ orgId });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(campaignHeaders())
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);

    const row = await getCampaignCost(campaignId);
    expect(row).not.toBeNull();
    expect(row?.lastAuthorizeRequiredCents).toBe("10.0000000000");
  });

  it("no x-campaign-id → no upsert (non-campaign authorize)", async () => {
    await insertTestAccount({ orgId });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("1000.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId, userId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    const row = await getCampaignCost(campaignId);
    expect(row).toBeNull();
  });

  it("re-run with a new required_cents → upserts in place (latest wins)", async () => {
    await insertTestAccount({ orgId });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("1000.0000000000");

    setRequired("10.0000000000");
    await request(app)
      .post("/v1/customer_balance/authorize")
      .set(campaignHeaders())
      .send(authorizeBody);

    setRequired("25.5000000000");
    await request(app)
      .post("/v1/customer_balance/authorize")
      .set(campaignHeaders())
      .send(authorizeBody);

    const row = await getCampaignCost(campaignId);
    expect(row?.lastAuthorizeRequiredCents).toBe("25.5000000000");
  });
});
