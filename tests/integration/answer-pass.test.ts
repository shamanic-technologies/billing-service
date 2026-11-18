/**
 * REPLY-NO-BALANCE-1118: answering a person who wrote to us is never refused by an empty balance.
 * Example: Doc Dinners at $0 (auto top-up off, no card), a doctor asks for prices; campaign-service
 * admits the answering run and grants a pass on the campaign: its LLM call and send authorize.
 * New outreach (a campaign with no pass) stays refused.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { _resetCoalescer } from "../../src/lib/reload-coalescer.js";

const orgId = "00000000-0000-4000-8000-0000000009a1";
const answerCampaignId = "00000000-0000-4000-8000-0000000009c1";
const outreachCampaignId = "00000000-0000-4000-8000-0000000009c2";
const runId = "00000000-0000-4000-8000-0000000009d1";

describe("answer passes: a reply goes out at a $0 balance, new outreach does not", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    _resetCoalescer();
    await cleanTestData();
    await insertTestAccount({ orgId });
    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("a@b.test"));
    ssMocks.getCustomerByOrg.mockResolvedValue(customerWithEmail("a@b.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({ org_id: orgId, spent_cents: "0", as_of: "2026-11-18T00:00:00.000Z" });
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({ spent_cents: "0" });
    vi.spyOn(runsClient, "fetchRunsOrgNoCampaignTotal").mockResolvedValue({ usageNetCents: "0", actualNetCents: "0" });
    const costs = await import("../../src/lib/costs-client.js");
    vi.spyOn(costs, "resolveRequiredCents").mockResolvedValue("3.0000000000");
  });

  afterAll(async () => {
    await closeDb();
  });

  const authorize = (campaignId: string) =>
    request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId), "x-campaign-id": campaignId })
      .send({ items: [{ costName: "chat", quantity: 1 }] });

  it("without a pass the campaign spend is refused at $0", async () => {
    const res = await authorize(answerCampaignId);
    expect(res.body.sufficient).toBe(false);
  });

  it("with a live pass the answering campaign's spend is granted; another campaign stays refused", async () => {
    const grant = await request(app)
      .post("/internal/answer-passes")
      .set({ "X-API-Key": "test-api-key" })
      .send({ orgId, campaignId: answerCampaignId, runId, leadId: null });
    expect(grant.status).toBe(201);
    expect(new Date(grant.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const answer = await authorize(answerCampaignId);
    expect(answer.status).toBe(200);
    expect(answer.body.sufficient).toBe(true);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();

    const outreach = await authorize(outreachCampaignId);
    expect(outreach.body.sufficient).toBe(false);
  });

  it("an expired pass grants nothing", async () => {
    const { grantAnswerPass } = await import("../../src/lib/answer-pass.js");
    await grantAnswerPass({ orgId, campaignId: answerCampaignId, runId }, new Date(Date.now() - 31 * 60_000));
    const res = await authorize(answerCampaignId);
    expect(res.body.sufficient).toBe(false);
  });

  it("rejects a body without a run", async () => {
    const res = await request(app)
      .post("/internal/answer-passes")
      .set({ "X-API-Key": "test-api-key" })
      .send({ orgId, campaignId: answerCampaignId });
    expect(res.status).toBe(400);
  });
});
