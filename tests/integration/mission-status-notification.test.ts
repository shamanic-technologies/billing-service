import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { campaignDailyBudgets } from "../../src/db/schema.js";

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
    // No budget held: the pause states no amount at all.
    expect(call.metadata.action).toBe("paused sales-cold-email-outreach (leg start_to_conversation)");
    expect(call.metadata.subject).toBe("A brand: sales-cold-email-outreach (leg start_to_conversation) paused");
    expect(`${call.metadata.action}${call.metadata.summaryText}`).not.toContain("kept");
  });

  // Legistai, 2026-10-06: the subscriber plan reallocation DELETED the paused
  // cold-email ceiling in the same second, while the email, composed in
  // parallel, still read it and said "$3/day kept". The email must compose from
  // the ceilings as they stand AFTER that reallocation.
  it("a pause reads the ceilings AFTER the plan reallocation deleted the paused row", async () => {
    const offerId = "0f1e2d3c-4b5a-4697-8877-665544332211";
    await db.insert(campaignDailyBudgets).values([
      { orgId, brandId, featureSlug: "sales-cold-email-outreach", offerId, legKey: "start_to_conversation", dailyBudgetCents: "330" },
      { orgId, brandId, featureSlug: "ai-meeting-booking", offerId, legKey: "conversation_to_meeting_booked", dailyBudgetCents: "30" },
    ]);
    const plan = await import("../../src/lib/subscriber-plan-budgets.js");
    let reallocated = false;
    vi.spyOn(plan, "onMissionStatusChanged").mockImplementation(async () => {
      // A real reallocation takes a few round-trips (advisory lock, live status read).
      await new Promise((r) => setTimeout(r, 50));
      await db
        .delete(campaignDailyBudgets)
        .where(and(eq(campaignDailyBudgets.brandId, brandId), eq(campaignDailyBudgets.featureSlug, "sales-cold-email-outreach")));
      reallocated = true;
    });

    const res = await post({ offerId, fromStatus: "ongoing", toStatus: "stopped" });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(sendEmailSpy).toHaveBeenCalledTimes(1));
    expect(reallocated).toBe(true);
    const { metadata } = sendEmailSpy.mock.calls[0][0];
    const all = `${metadata.subject}\n${metadata.action}\n${metadata.summaryText}`;
    expect(metadata.action).toBe(
      "paused sales-cold-email-outreach (leg start_to_conversation, offer 0f1e2d3c, name unavailable)"
    );
    expect(all).not.toMatch(/kept|\$3\.30|\$3\b/);
    // What billing still holds is stated, with its cents.
    expect(metadata.summaryText).toContain("ai-meeting-booking (leg conversation_to_meeting_booked) $0.30");
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
