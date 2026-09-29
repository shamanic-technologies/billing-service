import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const orgId = "00000000-0000-0000-0000-00000000c201";
const userId = "00000000-0000-0000-0000-00000000c299";
const runId = "00000000-0000-0000-0000-00000000caaa";
const brandId = "00000000-0000-0000-0000-0000000cd601";
const campaignId = "00000000-0000-0000-0000-0000000ca001";

const headers = {
  "X-API-Key": "test-api-key",
  "x-org-id": orgId,
  "x-user-id": userId,
  "x-run-id": runId,
};

// campaign-service tells billing a PERSON paused or restarted a mission; billing
// sends the SAME staff email as a budget change (one event, one template).
describe("POST /internal/brands/:brandId/mission-status-changed", () => {
  const app = createTestApp();
  let sendEmailSpy: ReturnType<typeof vi.fn>;
  const featuresUrl = process.env.FEATURES_SERVICE_URL;

  beforeEach(async () => {
    vi.restoreAllMocks();
    delete process.env.FEATURES_SERVICE_URL;
    delete process.env.CAMPAIGN_SERVICE_URL;
    delete process.env.CAMPAIGN_SERVICE_API_KEY;
    await cleanTestData();
    const emailClient = await import("../../src/lib/email-client.js");
    sendEmailSpy = vi.fn();
    vi.spyOn(emailClient, "sendEmail").mockImplementation(sendEmailSpy);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    process.env.FEATURES_SERVICE_URL = featuresUrl;
    await cleanTestData();
    await closeDb();
  });

  function post(body: Record<string, unknown>) {
    return request(app)
      .post(`/internal/brands/${brandId}/mission-status-changed`)
      .set(headers)
      .send({
        campaignId,
        featureSlug: "sales-cold-email-outreach",
        offerId: null,
        legKey: "start_to_conversation",
        ...body,
      });
  }

  it("a pause answers 202 and sends the budget-change event with the pause wording", async () => {
    const res = await post({ fromStatus: "ongoing", toStatus: "stopped" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ notified: true, move: "paused" });
    await vi.waitFor(() => expect(sendEmailSpy).toHaveBeenCalledTimes(1));
    const call = sendEmailSpy.mock.calls[0][0];
    expect(call.eventType).toBe("brand_daily_budget_changed");
    expect(call.metadata.action).toBe("paused a mission");
    expect(call.metadata.summaryText).toContain("paused (no budget set)");
  });

  it("a no-op sends nothing", async () => {
    const res = await post({ fromStatus: "ongoing", toStatus: "ongoing" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ notified: false, move: null });
    for (let i = 0; i < 20; i++) await new Promise(setImmediate);
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it("a malformed body is refused", async () => {
    const res = await post({ campaignId: "nope", fromStatus: "ongoing", toStatus: "stopped" });
    expect(res.status).toBe(400);
  });
});
