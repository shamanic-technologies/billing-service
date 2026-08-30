import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const orgId = "00000000-0000-0000-0000-00000000b201";
const otherOrgId = "00000000-0000-0000-0000-00000000b202";
const userId = "00000000-0000-0000-0000-00000000b299";
const runId = "00000000-0000-0000-0000-00000000baaa";
const brandId = "00000000-0000-0000-0000-0000000bd601";

const apiKeyHeaders = { "X-API-Key": "test-api-key" };
const internalHeaders = (id: string) => ({ ...apiKeyHeaders, "x-org-id": id });

function readPath(id: string) {
  return `/internal/brands/${id}/daily-budget`;
}
function setPath(id: string) {
  return `/v1/brands/${id}/daily-budget`;
}
function historyPath(id: string) {
  return `/internal/brands/${id}/daily-budget/history`;
}

// --- staff notification on a real daily-budget change ---
//
// Event key + template name are byte-equal to what transactional-email-service
// routes to its staff recipient list (PR #108). No staff address lives here.
//
// The send is fire-and-forget AND now reads campaign-service for the running
// split before it fires, so the route answers BEFORE the send happens. Every
// assertion therefore waits for the send rather than reading it off the
// response — which is also the property under test: the write's status code,
// body and latency owe nothing to either sibling.
describe("brand daily budget → staff notification", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders(orgId, userId, runId);
  let sendEmailSpy: ReturnType<typeof vi.fn>;

  async function spyOnSendEmail(impl?: () => void) {
    const emailClient = await import("../../src/lib/email-client.js");
    sendEmailSpy = vi.fn(impl);
    vi.spyOn(emailClient, "sendEmail").mockImplementation(sendEmailSpy);
  }

  /** Wait for the fire-and-forget notification to reach the email client. */
  async function sentCall(nth = 0) {
    await vi.waitFor(() =>
      expect(sendEmailSpy.mock.calls.length).toBeGreaterThan(nth)
    );
    return sendEmailSpy.mock.calls[nth][0];
  }

  /** Give the notification a chance to fire, for the cases asserting it did not. */
  async function settle() {
    for (let i = 0; i < 20; i++) await new Promise(setImmediate);
  }

  function setBudget(amount: number | string, headers = authHeaders) {
    return request(app)
      .patch(setPath(brandId))
      .set(headers)
      .send({ dailyBudgetCents: amount });
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    delete process.env.CAMPAIGN_SERVICE_URL;
    delete process.env.CAMPAIGN_SERVICE_API_KEY;
    await cleanTestData();
    await spyOnSendEmail();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    delete process.env.CAMPAIGN_SERVICE_URL;
    delete process.env.CAMPAIGN_SERVICE_API_KEY;
    await cleanTestData();
    await closeDb();
  });

  it("a first-ever set notifies once, with the previous side shown as unset", async () => {
    const res = await setBudget(5000);

    expect(res.status).toBe(200);
    const call = await sentCall();
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    expect(call.eventType).toBe("brand_daily_budget_changed");
    expect(call.orgId).toBe(orgId);
    expect(call.userId).toBe(userId);
    expect(call.runId).toBe(runId);
    expect(call.metadata).toMatchObject({
      brandId,
      orgId,
      previousBudget: "unset",
      newBudget: "$50/day",
    });
    // No staff address is named by billing — the email service owns who staff is.
    expect(call.recipientEmail).toBeUndefined();
  });

  it("a different value notifies exactly once, reporting previous and new", async () => {
    await setBudget(5000);
    await sentCall();
    sendEmailSpy.mockClear();

    await setBudget(9900);

    expect((await sentCall()).metadata).toMatchObject({
      previousBudget: "$50/day",
      newBudget: "$99/day",
    });
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
  });

  it("re-saving the SAME value notifies nothing", async () => {
    await setBudget(5000);
    await sentCall();
    sendEmailSpy.mockClear();

    const res = await setBudget(5000);
    await settle();

    expect(res.status).toBe(200);
    expect(res.body.dailyBudgetCents).toBe("5000.0000000000");
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it("a change to zero reads as a pause, not as 'changed to 0'", async () => {
    await setBudget(5000);
    await sentCall();
    sendEmailSpy.mockClear();

    await setBudget(0);

    expect((await sentCall()).metadata).toMatchObject({
      previousBudget: "$50/day",
      newBudget: "paused ($0/day)",
    });
  });

  it("leaving a pause notifies with the pause as the previous side", async () => {
    await setBudget(0);
    await sentCall();
    sendEmailSpy.mockClear();

    await setBudget(8000);

    expect((await sentCall()).metadata).toMatchObject({
      previousBudget: "paused ($0/day)",
      newBudget: "$80/day",
    });
  });

  it("never prints fractional cents on a fractional stored budget", async () => {
    await setBudget(0);
    await sentCall();
    sendEmailSpy.mockClear();

    await setBudget("5049.5");

    expect((await sentCall()).metadata.newBudget).toBe("$50/day");
  });

  it("forwards the acting staff email when the gateway supplies x-email", async () => {
    await setBudget(5000, { ...authHeaders, "x-email": "staff@distribute.you" });

    expect((await sentCall()).metadata.email).toBe("staff@distribute.you");
  });

  it("omits email so the email service fills it from x-user-id when no x-email", async () => {
    await setBudget(5000);

    expect((await sentCall()).metadata.email).toBeUndefined();
  });

  it("a different org's write reports ITS OWN previous value, not another org's", async () => {
    await setBudget(5000);
    await setBudget(1000, getAuthHeaders(otherOrgId, userId, runId));
    await vi.waitFor(() => expect(sendEmailSpy).toHaveBeenCalledTimes(2));
    sendEmailSpy.mockClear();

    await setBudget(2000, getAuthHeaders(otherOrgId, userId, runId));

    expect((await sentCall()).metadata).toMatchObject({
      previousBudget: "$10/day",
      newBudget: "$20/day",
    });
  });

  it("an erroring email client changes neither the status code nor the body", async () => {
    await spyOnSendEmail(() => {
      throw new Error("transactional-email-service unreachable");
    });

    const res = await setBudget(5000);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      brandId,
      orgId,
      dailyBudgetCents: "5000.0000000000",
      updatedAt: expect.any(String),
    });

    // and the write itself still landed
    const read = await request(app)
      .get(readPath(brandId))
      .set(internalHeaders(orgId));
    expect(read.body.dailyBudgetCents).toBe("5000.0000000000");
  });

  it("an unreachable email service (rejected fetch) still returns 200", async () => {
    vi.restoreAllMocks();
    process.env.TRANSACTIONAL_EMAIL_SERVICE_URL = "http://localhost:9995";
    process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-email-service-key";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ECONNREFUSED"));

    try {
      const res = await setBudget(7500);
      expect(res.status).toBe(200);
      expect(res.body.dailyBudgetCents).toBe("7500.0000000000");
      await vi.waitFor(() =>
        expect(fetchSpy).toHaveBeenCalledWith(
          "http://localhost:9995/send",
          expect.objectContaining({ method: "POST" })
        )
      );
    } finally {
      delete process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
      delete process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
    }
  });

  it("the history row and current value are unchanged by the notification", async () => {
    for (const amount of [5000, 5000, 0]) await setBudget(amount);
    await settle();

    const history = await request(app)
      .get(historyPath(brandId))
      .set(internalHeaders(orgId));

    // Every write is still journaled, including the no-op re-save.
    expect(
      history.body.history.map((h: { dailyBudgetCents: string }) => h.dailyBudgetCents)
    ).toEqual(["5000.0000000000", "5000.0000000000", "0.0000000000"]);

    const read = await request(app)
      .get(readPath(brandId))
      .set(internalHeaders(orgId));
    expect(read.body.dailyBudgetCents).toBe("0.0000000000");
  });

  // --- the running split (campaign-service unconfigured / unreachable) ---

  it("says the running split is unavailable rather than quoting a configured total", async () => {
    await setBudget(5000);

    const { metadata } = await sentCall();
    expect(metadata.previousRunningBudget).toBe("unavailable");
    expect(metadata.newRunningBudget).toBe("unavailable");
    expect(metadata.runningNote).toContain("campaign-service could not be read");
    // The configured totals are still stated in full.
    expect(metadata.previousBudget).toBe("unset");
    expect(metadata.newBudget).toBe("$50/day");
  });

  it("a hanging campaign-service changes neither the status code, body nor the write", async () => {
    process.env.CAMPAIGN_SERVICE_URL = "http://localhost:9994";
    process.env.CAMPAIGN_SERVICE_API_KEY = "test-campaign-key";
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise(() => {}) as Promise<Response>
    );

    const res = await setBudget(5000);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      brandId,
      orgId,
      dailyBudgetCents: "5000.0000000000",
      updatedAt: expect.any(String),
    });
    // Nothing was sent (the read never resolves), and nothing blocked the write.
    await settle();
    expect(sendEmailSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    await spyOnSendEmail();
    const read = await request(app)
      .get(readPath(brandId))
      .set(internalHeaders(orgId));
    expect(read.body.dailyBudgetCents).toBe("5000.0000000000");
  });
});
