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
import { FOLLOWUP_3D_MS, FOLLOWUP_10D_MS } from "../../src/lib/dunning.js";

const orgId = "00000000-0000-0000-0000-00000000d001";
const userId = "00000000-0000-0000-0000-000000000099";
const campaignId = "00000000-0000-0000-0000-0000000ca001";
const billingEmail = "founder@acme.test";

const authorizeBody = {
  items: [{ costName: "anthropic-sonnet-4-5-tokens-input", quantity: 1000 }],
  description: "dunning test",
};

function campaignHeaders() {
  return { ...getAuthHeaders(orgId, userId), "x-campaign-id": campaignId };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("Out-of-credit dunning engine (issue #147)", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let sendEmailSpy: ReturnType<typeof vi.fn>;
  let setUsage: (cents: string) => void;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail(billingEmail));
    await cleanTestData();

    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue("10.0000000000");

    const runsClient = await import("../../src/lib/runs-client.js");
    let usage = "0.0000000000";
    setUsage = (cents: string) => {
      usage = cents;
    };
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage,
      as_of: "2026-06-08T00:00:00.000Z",
    }));

    const emailClient = await import("../../src/lib/email-client.js");
    sendEmailSpy = vi.fn();
    vi.spyOn(emailClient, "sendEmail").mockImplementation(sendEmailSpy);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  // balance = credited − usage. credited = paidTopups (no promos in these tests).
  // setBalance controls credited (the recovery baseline); setUsage controls usage
  // (the provisioned-churn axis that flutters balance WITHOUT changing credited).
  function setBalance(paidTopupsCents: string) {
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(paidTopupsCents);
  }

  async function tick() {
    return request(app)
      .post("/internal/dunning/tick")
      .set({ "X-API-Key": "test-api-key" });
  }

  it("1: authorize fails depleted with campaign → opens episode + sends T0 once", async () => {
    await insertTestAccount({ orgId }); // no topup config
    setBalance("0.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(campaignHeaders())
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);

    const episodes = await listEpisodes(orgId);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].recoveredAt).toBeNull();
    expect(episodes[0].t0SentAt).not.toBeNull();
    expect(episodes[0].campaignId).toBe(campaignId);

    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    expect(sendEmailSpy.mock.calls[0][0]).toMatchObject({
      eventType: "credit-depleted",
      recipientEmail: billingEmail,
      metadata: {},
    });
  });

  it("2: two depleted authorizes → still one episode, T0 sent once (idempotent)", async () => {
    await insertTestAccount({ orgId });
    setBalance("0.0000000000");

    await request(app).post("/v1/customer_balance/authorize").set(campaignHeaders()).send(authorizeBody);
    await request(app).post("/v1/customer_balance/authorize").set(campaignHeaders()).send(authorizeBody);

    const episodes = await listEpisodes(orgId);
    expect(episodes).toHaveLength(1);
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
  });

  it("3: depleted but NO workflow context → no episode, no email", async () => {
    await insertTestAccount({ orgId });
    setBalance("0.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId, userId)) // no x-campaign-id / workflow headers
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
    expect(await listEpisodes(orgId)).toHaveLength(0);
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it("4: insufficient but balance > 0 (not depleted) → no episode", async () => {
    await insertTestAccount({ orgId });
    setBalance("5.0000000000"); // balance 5 > 0, but required 10 → insufficient

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(campaignHeaders())
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
    expect(await listEpisodes(orgId)).toHaveLength(0);
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it("5: tick on episode aged ≥3d still depleted → sends +3d follow-up", async () => {
    setBalance("0.0000000000");
    await insertTestEpisode({
      orgId,
      userId,
      campaignId,
      startedAt: new Date(Date.now() - 4 * DAY_MS),
    });

    const res = await tick();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ processed: 1, recovered: 0, followup3dSent: 1, followup10dSent: 0 });

    const [ep] = await listEpisodes(orgId);
    expect(ep.followup3dSentAt).not.toBeNull();
    expect(ep.followup10dSentAt).toBeNull();
    expect(ep.recoveredAt).toBeNull();
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    expect(sendEmailSpy.mock.calls[0][0]).toMatchObject({
      eventType: "credit-depleted-followup-3d",
      recipientEmail: billingEmail,
    });
  });

  it("6: tick on episode aged ≥10d still depleted → sends both +3d and +10d", async () => {
    setBalance("0.0000000000");
    await insertTestEpisode({
      orgId,
      userId,
      campaignId,
      startedAt: new Date(Date.now() - 11 * DAY_MS),
    });

    const res = await tick();
    expect(res.body).toMatchObject({ processed: 1, followup3dSent: 1, followup10dSent: 1 });

    const [ep] = await listEpisodes(orgId);
    expect(ep.followup3dSentAt).not.toBeNull();
    expect(ep.followup10dSentAt).not.toBeNull();
    const eventTypes = sendEmailSpy.mock.calls.map((c) => c[0].eventType).sort();
    expect(eventTypes).toEqual(["credit-depleted-followup-10d", "credit-depleted-followup-3d"]);
  });

  it("7: tick when balance restored → closes episode, sends nothing (stop-on-recharge)", async () => {
    setBalance("100.0000000000"); // restored
    await insertTestEpisode({
      orgId,
      userId,
      campaignId,
      startedAt: new Date(Date.now() - 4 * DAY_MS),
    });

    const res = await tick();
    expect(res.body).toMatchObject({ processed: 1, recovered: 1, followup3dSent: 0, followup10dSent: 0 });

    const [ep] = await listEpisodes(orgId);
    expect(ep.recoveredAt).not.toBeNull();
    expect(ep.followup3dSentAt).toBeNull();
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it("8: re-running the tick never double-sends a stage", async () => {
    setBalance("0.0000000000");
    await insertTestEpisode({
      orgId,
      userId,
      campaignId,
      startedAt: new Date(Date.now() - 4 * DAY_MS),
    });

    await tick();
    const second = await tick();

    expect(second.body).toMatchObject({ followup3dSent: 0 });
    expect(sendEmailSpy).toHaveBeenCalledTimes(1); // only the first tick sent
  });

  it("9: recovery then new depletion re-arms a fresh episode", async () => {
    await insertTestAccount({ orgId });

    // depletion #1 → episode opens
    setBalance("0.0000000000");
    await request(app).post("/v1/customer_balance/authorize").set(campaignHeaders()).send(authorizeBody);
    expect(await listEpisodes(orgId)).toHaveLength(1);

    // recharge → tick closes the episode
    setBalance("100.0000000000");
    await tick();
    const afterRecovery = await listEpisodes(orgId);
    expect(afterRecovery).toHaveLength(1);
    expect(afterRecovery[0].recoveredAt).not.toBeNull();

    // depletion #2 → a brand-new episode opens (partial-unique re-arm)
    setBalance("0.0000000000");
    await request(app).post("/v1/customer_balance/authorize").set(campaignHeaders()).send(authorizeBody);

    const all = await listEpisodes(orgId);
    expect(all).toHaveLength(2);
    expect(all.filter((e) => e.recoveredAt === null)).toHaveLength(1);
    // T0 fired for both episodes
    const t0Count = sendEmailSpy.mock.calls.filter((c) => c[0].eventType === "credit-depleted").length;
    expect(t0Count).toBe(2);
  });

  it("11: balance flutters positive via usage drop (no recharge) → NOT recovered, no 2nd T0", async () => {
    await insertTestAccount({ orgId }); // no topup config
    // credited 50, usage 60 → balance -10 depleted. Opens episode, baseline credited 50.
    setBalance("50.0000000000");
    setUsage("60.0000000000");
    await request(app).post("/v1/customer_balance/authorize").set(campaignHeaders()).send(authorizeBody);
    expect(await listEpisodes(orgId)).toHaveLength(1);
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);

    // Provisioned hold released: usage drops to 40 → balance +10, but credited
    // unchanged (still 50). Tick must NOT recover (this was the duplicate-email bug).
    setUsage("40.0000000000");
    const res = await tick();
    expect(res.body).toMatchObject({ processed: 1, recovered: 0 });
    const [stillOpen] = await listEpisodes(orgId);
    expect(stillOpen.recoveredAt).toBeNull();

    // New provision: usage back to 60 → depleted again. The open episode blocks a
    // re-arm (partial-unique) → still one episode, still one T0.
    setUsage("60.0000000000");
    await request(app).post("/v1/customer_balance/authorize").set(campaignHeaders()).send(authorizeBody);
    expect(await listEpisodes(orgId)).toHaveLength(1);
    const t0Count = sendEmailSpy.mock.calls.filter((c) => c[0].eventType === "credit-depleted").length;
    expect(t0Count).toBe(1);
  });

  it("12: real recharge (credited rises above baseline) → recovered, episode closed", async () => {
    setBalance("50.0000000000");
    await insertTestEpisode({
      orgId,
      userId,
      campaignId,
      creditedCentsAtOpen: "50.0000000000",
      startedAt: new Date(Date.now() - 4 * DAY_MS),
    });

    // Paid topup lands: credited 50 → 200 (> baseline). Recover, no email.
    setBalance("200.0000000000");
    const res = await tick();
    expect(res.body).toMatchObject({ processed: 1, recovered: 1, followup3dSent: 0 });
    const [ep] = await listEpisodes(orgId);
    expect(ep.recoveredAt).not.toBeNull();
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it("13: pre-0020 episode (null baseline) → tick lazily backfills, no recovery; real recharge still recovers", async () => {
    // Row opened before migration 0020: no baseline. Balance positive at tick.
    setBalance("50.0000000000");
    await insertTestEpisode({
      orgId,
      userId,
      campaignId,
      creditedCentsAtOpen: null,
    });

    // First tick captures baseline = current credited (50); does NOT recover.
    const first = await tick();
    expect(first.body).toMatchObject({ processed: 1, recovered: 0 });
    const [afterBackfill] = await listEpisodes(orgId);
    expect(afterBackfill.recoveredAt).toBeNull();
    expect(afterBackfill.creditedCentsAtOpen).toBe("50.0000000000");
    expect(sendEmailSpy).not.toHaveBeenCalled();

    // Real recharge above the now-captured baseline → recover.
    setBalance("300.0000000000");
    const second = await tick();
    expect(second.body).toMatchObject({ processed: 1, recovered: 1 });
    const [recovered] = await listEpisodes(orgId);
    expect(recovered.recoveredAt).not.toBeNull();
  });

  it("14: blocked-card org (IN) depleted → T0 routes to credit-depleted-blocked", async () => {
    await insertTestAccount({ orgId }); // no topup config
    setBalance("0.0000000000");
    // Card issued in an auto-reload-blocked country (India) → autoReloadSupported=false.
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("IN");

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(campaignHeaders())
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    expect(sendEmailSpy.mock.calls[0][0]).toMatchObject({
      eventType: "credit-depleted-blocked",
      recipientEmail: billingEmail,
    });
  });

  it("15: blocked-card org (IN) tick aged ≥10d → +3d/+10d route to -blocked variants", async () => {
    setBalance("0.0000000000");
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("IN");
    await insertTestEpisode({
      orgId,
      userId,
      campaignId,
      startedAt: new Date(Date.now() - 11 * DAY_MS),
    });

    const res = await tick();
    expect(res.body).toMatchObject({ processed: 1, followup3dSent: 1, followup10dSent: 1 });

    const eventTypes = sendEmailSpy.mock.calls.map((c) => c[0].eventType).sort();
    expect(eventTypes).toEqual([
      "credit-depleted-followup-10d-blocked",
      "credit-depleted-followup-3d-blocked",
    ]);
  });

  it("16: supported-card org (no blocked country) → base events, NOT -blocked", async () => {
    setBalance("0.0000000000");
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US"); // not blocked
    await insertTestEpisode({
      orgId,
      userId,
      campaignId,
      startedAt: new Date(Date.now() - 11 * DAY_MS),
    });

    await tick();
    const eventTypes = sendEmailSpy.mock.calls.map((c) => c[0].eventType).sort();
    expect(eventTypes).toEqual(["credit-depleted-followup-10d", "credit-depleted-followup-3d"]);
  });

  it("17: auto-topup org negative WITHIN the credit line → sufficient:true, NO episode, NO T0", async () => {
    // Enabled org (card + config). paid 0 → floor -5000. usage 4000 → balance -4000,
    // still above the floor → the run proceeds on credit, no depletion, no email.
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 1000 });
    setBalance("0.0000000000");
    setUsage("4000.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(campaignHeaders())
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);
    expect(await listEpisodes(orgId)).toHaveLength(0);
    expect(sendEmailSpy).not.toHaveBeenCalled();
    expect(ssMocks.reloadViaInvoice).not.toHaveBeenCalled();
  });

  it("18: auto-topup org crosses the floor + reload fails → opens episode, sends T0", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 1000 });
    setBalance("0.0000000000");
    setUsage("5001.0000000000"); // balance -5001, past the -5000 floor
    ssMocks.reloadViaInvoice.mockResolvedValue({
      status: "failed",
      failure_reason: "card_declined",
    });

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(campaignHeaders())
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
    expect(await listEpisodes(orgId)).toHaveLength(1);
    const t0 = sendEmailSpy.mock.calls.filter((c) => c[0].eventType === "credit-depleted");
    expect(t0).toHaveLength(1);
    expect(t0[0][0]).toMatchObject({ recipientEmail: billingEmail });
  });

  it("10: tick endpoint returns a summary over multiple open episodes", async () => {
    setBalance("0.0000000000");
    // window sanity: constants exported for any caller
    expect(FOLLOWUP_3D_MS).toBeLessThan(FOLLOWUP_10D_MS);
    await insertTestEpisode({ orgId, userId, campaignId, startedAt: new Date(Date.now() - 4 * DAY_MS) });

    const res = await tick();
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(1);
  });
});
