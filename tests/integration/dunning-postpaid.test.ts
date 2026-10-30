import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestAccount,
  insertTestEpisode,
  listEpisodes,
  closeDb,
} from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";

// POSTPAID-DUNNING-1030 (owner 2026-10-30): a postpaid org keeps receiving the
// out-of-credit follow-ups, worded for how it pays (settle the balance due),
// never "add credit / turn on auto top-up". Prepaid is unchanged.

const orgId = "00000000-0000-0000-0000-00000000d0a1";
const userId = "00000000-0000-0000-0000-000000000099";
const campaignId = "00000000-0000-0000-0000-0000000ca0a1";
const billingEmail = "founder@postpaid.test";
const DAY_MS = 24 * 60 * 60 * 1000;

const authorizeBody = {
  items: [{ costName: "anthropic-sonnet-4-5-tokens-input", quantity: 1000 }],
  description: "postpaid dunning test",
};

describe("Postpaid dunning twins (POSTPAID-DUNNING-1030)", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let sendEmailSpy: ReturnType<typeof vi.fn>;
  let usage = "0.0000000000";

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail(billingEmail));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    await cleanTestData();
    usage = "0.0000000000";

    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue("10.0000000000");

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage,
      as_of: "2026-10-30T00:00:00.000Z",
    }));
    // Postpaid gates read BILLED usage: no holds, actual == usage.
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async () => ({
      spent_cents: usage,
    }));
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue(
      "eeeeeeee-2222-4eee-8eee-222222222222"
    );
    vi.spyOn(runsClient, "completePlatformRun").mockResolvedValue(undefined);

    const emailClient = await import("../../src/lib/email-client.js");
    sendEmailSpy = vi.fn();
    vi.spyOn(emailClient, "sendEmail").mockImplementation(sendEmailSpy);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  function dunningSends(): string[] {
    return sendEmailSpy.mock.calls
      .map((c) => c[0].eventType as string)
      .filter((t) => t.startsWith("credit-depleted"))
      .sort();
  }

  it("postpaid org past its credit line → T0 is credit-depleted-postpaid", async () => {
    await insertTestAccount({
      orgId,
      paymentMode: "postpaid",
      topupAmountCents: 5000,
      topupThresholdCents: 1000,
    });
    usage = "5001.0000000000"; // billed -50.01, past the -$50 line
    ssMocks.reloadOffSession.mockResolvedValue({
      status: "failed",
      failure_reason: "card_declined",
    });

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId, userId), "x-campaign-id": campaignId })
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
    expect(await listEpisodes(orgId)).toHaveLength(1);
    expect(dunningSends()).toEqual(["credit-depleted-postpaid"]);
    const t0 = sendEmailSpy.mock.calls.find(
      (c) => c[0].eventType === "credit-depleted-postpaid"
    );
    expect(t0?.[0]).toMatchObject({ recipientEmail: billingEmail });
  });

  it("postpaid org, episode aged ≥10d → +3d / +10d are the -postpaid twins", async () => {
    await insertTestAccount({ orgId, paymentMode: "postpaid" });
    usage = "5001.0000000000";
    await insertTestEpisode({
      orgId,
      userId,
      campaignId,
      startedAt: new Date(Date.now() - 11 * DAY_MS),
    });

    const res = await request(app)
      .post("/internal/dunning/tick")
      .set({ "X-API-Key": "test-api-key" });

    expect(res.body).toMatchObject({ processed: 1, followup3dSent: 1, followup10dSent: 1 });
    expect(dunningSends()).toEqual([
      "credit-depleted-followup-10d-postpaid",
      "credit-depleted-followup-3d-postpaid",
    ]);
  });

  it("prepaid org, episode aged ≥10d → base follow-ups, unchanged", async () => {
    await insertTestAccount({ orgId, paymentMode: "prepaid" });
    usage = "10.0000000000";
    await insertTestEpisode({
      orgId,
      userId,
      campaignId,
      startedAt: new Date(Date.now() - 11 * DAY_MS),
    });

    await request(app).post("/internal/dunning/tick").set({ "X-API-Key": "test-api-key" });
    expect(dunningSends()).toEqual([
      "credit-depleted-followup-10d",
      "credit-depleted-followup-3d",
    ]);
  });

  it("subscription org depleted → no dunning mail at all, unchanged", async () => {
    await insertTestAccount({ orgId, paymentMode: "subscription" });
    usage = "10.0000000000";

    await request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId, userId), "x-campaign-id": campaignId })
      .send(authorizeBody);

    expect(await listEpisodes(orgId)).toHaveLength(0);
    expect(dunningSends()).toEqual([]);
  });
});
