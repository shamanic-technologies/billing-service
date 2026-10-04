import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaignDailyBudgets } from "../../src/db/schema.js";

// The prod case this exists for (2026-08-31): brand 75d7e3e8-… of org
// b645207b-…, whose reply-to-meeting leg is worked by two campaigns —
// $200/day ONGOING on the sales pitch, $10/day STOPPED on the feedback pitch.
// The email said "Was $110/day → Now $210/day" on a raise that moved the money
// the brand can actually spend from $100 to $200.
const orgId = "b645207b-d8e9-40b0-9391-072b777cd9a9";
const userId = "00000000-0000-0000-0000-00000000c299";
const runId = "00000000-0000-0000-0000-00000000caaa";
const brandId = "75d7e3e8-6926-4f85-a557-976895400666";

const OFFER = "d5ecba00-1111-4000-8000-000000000001";
const LEG = "start_to_conversation";
const RUNNING_CHANNEL = "sales-cold-email-outreach";
const PAUSED_CHANNEL = "feedback-request-cold-email-outreach";

describe("brand budget notification → running headline", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders(orgId, userId, runId);
  let sendEmailSpy: ReturnType<typeof vi.fn>;

  async function spyOnSendEmail() {
    const emailClient = await import("../../src/lib/email-client.js");
    sendEmailSpy = vi.fn();
    vi.spyOn(emailClient, "sendEmail").mockImplementation(sendEmailSpy);
  }

  /**
   * Stand in for campaign-service. Its ceilings mirror what billing now stores,
   * because that is exactly how the real service builds them — it reads billing
   * back.
   */
  function mockCampaignService(
    ceilings: Array<{ featureSlug: string; cents: number; running: boolean }>
  ) {
    process.env.CAMPAIGN_SERVICE_URL = "http://campaign.test";
    process.env.CAMPAIGN_SERVICE_API_KEY = "test-campaign-key";

    const rows = ceilings.map((c) => ({
      featureSlug: c.featureSlug,
      offerId: OFFER,
      legKey: LEG,
      resolvedOfferId: OFFER,
      dailyBudgetCents: c.cents,
      running: c.running,
      campaignId: `campaign-${c.featureSlug}`,
      campaignStatus: c.running ? "ongoing" : "stopped",
    }));

    const body = {
      orgId,
      brandId,
      grain: "channel",
      configuredDailyBudgetCents: ceilings.reduce((s, c) => s + c.cents, 0),
      runningDailyBudgetCents: ceilings
        .filter((c) => c.running)
        .reduce((s, c) => s + c.cents, 0),
      campaigns: ceilings.map((c) => ({
        campaignId: `campaign-${c.featureSlug}`,
        status: c.running ? "ongoing" : "stopped",
        running: c.running,
        featureSlug: c.featureSlug,
        offerId: OFFER,
        legKey: LEG,
        configuredDailyBudgetCents: c.cents,
        runningDailyBudgetCents: c.running ? c.cents : 0,
      })),
      rows,
    };

    process.env.FEATURES_SERVICE_URL = "http://features.test";
    const catalogue = {
      channels: [
        {
          slug: RUNNING_CHANNEL,
          name: "Sales Cold Email Outreach",
          stepTransitions: [
            { legKey: LEG, from: null, to: { label: "Positive reply" }, crewName: "Herald" },
          ],
        },
        {
          slug: PAUSED_CHANNEL,
          name: "Feedback Request Cold Email Outreach",
          stepTransitions: [
            { legKey: LEG, from: null, to: { label: "Positive reply" }, crewName: null },
          ],
        },
      ],
    };

    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === "http://features.test/public/channels") {
        return new Response(JSON.stringify(catalogue), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/spendable-budget")) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
  }

  async function sentMetadata() {
    await vi.waitFor(() => expect(sendEmailSpy).toHaveBeenCalled());
    return sendEmailSpy.mock.calls.at(-1)![0].metadata;
  }

  function putCampaign(featureSlug: string, dailyBudgetCents: number) {
    return request(app)
      .put(`/v1/brands/${brandId}/campaign-budget`)
      .set(authHeaders)
      .send({ offerId: OFFER, legKey: LEG, featureSlug, dailyBudgetCents });
  }

  async function seedBoth() {
    expect((await putCampaign(RUNNING_CHANNEL, 20000)).status).toBe(200);
    expect((await putCampaign(PAUSED_CHANNEL, 1000)).status).toBe(200);
    sendEmailSpy.mockClear();
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    delete process.env.CAMPAIGN_SERVICE_URL;
    delete process.env.CAMPAIGN_SERVICE_API_KEY;
    delete process.env.FEATURES_SERVICE_URL;
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

  it("names the changed mission and totals only running daily money", async () => {
    await seedBoth();

    mockCampaignService([
      { featureSlug: RUNNING_CHANNEL, cents: 21000, running: true },
      { featureSlug: PAUSED_CHANNEL, cents: 1000, running: false },
    ]);

    const res = await putCampaign(RUNNING_CHANNEL, 21000);
    expect(res.status).toBe(200);

    const { subject, summaryText } = await sentMetadata();
    expect(subject).toContain("raised Sales Cold Email Outreach · Positive reply: $200/day → $210/day");
    expect(summaryText).toContain(
      "Sales Cold Email Outreach · Positive reply"
    );
    // Crew names retired 2026-10-04: a legacy "Herald" or a null crewName in the
    // catalogue never reaches the email.
    expect(`${subject}${summaryText}`).not.toMatch(/Herald|crew/i);
    expect(summaryText).toContain("$200/day → $210/day (+$10, +5%)");
    expect(summaryText).toContain("Daily spend now: $210/day");
    expect(summaryText).toContain("Paused (amount kept, not spending)");
    expect(summaryText).toMatch(/Feedback Request Cold Email Outreach · Positive reply · .*: \$10\/day kept/);
    expect(summaryText).not.toContain("$220");
  });

  it("still sends when only PAUSED money moved, with the daily total unchanged", async () => {
    await seedBoth();

    mockCampaignService([
      { featureSlug: RUNNING_CHANNEL, cents: 20000, running: true },
      { featureSlug: PAUSED_CHANNEL, cents: 2000, running: false },
    ]);

    await putCampaign(PAUSED_CHANNEL, 2000);

    const { summaryText } = await sentMetadata();
    expect(summaryText).toContain("$10/day → $20/day (+$10, +100%)");
    expect(summaryText).toContain("Daily spend now: $200/day");
    expect(summaryText).toMatch(/: \$20\/day kept/);
  });

  it("a pre-offer ceiling the write ADOPTED shows as moved onto the named mission", async () => {
    await db.insert(campaignDailyBudgets).values({
      orgId,
      brandId,
      featureSlug: RUNNING_CHANNEL,
      offerId: null,
      legKey: null,
      dailyBudgetCents: "20000",
    });

    mockCampaignService([
      { featureSlug: RUNNING_CHANNEL, cents: 21000, running: true },
    ]);

    const res = await putCampaign(RUNNING_CHANNEL, 21000);
    expect(res.status).toBe(200);

    const { summaryText } = await sentMetadata();
    // A leg-less legacy row cannot be classified, so it carries no unit.
    expect(summaryText).toContain("no leg stated · no offer: $200 → paused ($0)");
    expect(summaryText).toContain("$0 → $210/day (+$210, new)");
    expect(summaryText).toContain("Daily spend now: $210/day");
  });

  it("an unreachable campaign-service leaves the write and the send intact", async () => {
    expect((await putCampaign(RUNNING_CHANNEL, 20000)).status).toBe(200);
    sendEmailSpy.mockClear();

    process.env.CAMPAIGN_SERVICE_URL = "http://campaign.test";
    process.env.CAMPAIGN_SERVICE_API_KEY = "test-campaign-key";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await putCampaign(RUNNING_CHANNEL, 21000);
    expect(res.status).toBe(200);
    expect(res.body.dailyBudgetCents).toBe("21000.0000000000");

    const { summaryText } = await sentMetadata();
    expect(summaryText).toContain("Daily spend now: unavailable");
    expect(summaryText).toContain("Campaign statuses could not be read");
  });
});
