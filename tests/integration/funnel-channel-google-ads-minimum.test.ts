/**
 * Google Ads on the wire: a managed acquisition channel whose viable floor is
 * its own ($5/day on each of the three visit-led funnels it sells), funded
 * through the same two write moments as every other channel.
 *
 * The point of the whole change is that a floor is a property of the funnel AND
 * the channel: the visit-to-meeting funnel needs $24/day of cold email and
 * $5/day of Google Ads, and stating one must not move the other.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const orgId = "00000000-0000-0000-0000-0000000ada01";
const userId = "00000000-0000-0000-0000-0000000ada99";
const runId = "00000000-0000-0000-0000-0000000adabb";
const brandId = "00000000-0000-0000-0000-00000000ab01";

const GOOGLE_ADS = "google-ads";
const COLD = "sales-cold-email-outreach";

const internalHeaders = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const funnelReadPath = `/internal/brands/${brandId}/funnel-budgets`;
const funnelSetPath = `/v1/brands/${brandId}/funnel-budgets`;
const funnelOnePath = (key: string) => `${funnelSetPath}/${key}`;

const app = createTestApp();

describe("Google Ads states its own daily minimum", () => {
  const authHeaders = getAuthHeaders(orgId, userId, runId);

  const setOne = (
    funnelKey: string,
    featureSlug: string,
    dailyBudgetCents: number
  ) =>
    request(app)
      .patch(funnelOnePath(funnelKey))
      .set(authHeaders)
      .send({ featureSlug, dailyBudgetCents });

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("refuses below $5/day and accepts $5 on each funnel it sells", async () => {
    for (const funnelKey of ["visit_meeting", "visit_signup", "visit_form"]) {
      const refused = await setOne(funnelKey, GOOGLE_ADS, 499);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toContain(GOOGLE_ADS);
      expect(refused.body.error).toContain("$5/day");

      const accepted = await setOne(funnelKey, GOOGLE_ADS, 500);
      expect(accepted.status).toBe(200);
    }

    const read = await request(app).get(funnelReadPath).set(internalHeaders);
    expect(read.body.dailyBudgetCents).toBe("1500.0000000000");
  });

  it("funds the $24/day visit-to-meeting funnel at $5 through Google Ads", async () => {
    // The funnel's own floor is $24/day, and it still is for cold email — the
    // $5 is the CHANNEL's floor, not a re-pricing of the funnel.
    const cheap = await setOne("visit_meeting", COLD, 500);
    expect(cheap.status).toBe(400);
    expect(cheap.body.error).toContain("$24/day");

    const ads = await setOne("visit_meeting", GOOGLE_ADS, 500);
    expect(ads.status).toBe(200);
  });

  it("keeps the other channels' floors when both fund one funnel", async () => {
    const both = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_meeting", featureSlug: COLD, dailyBudgetCents: 2400 },
          {
            funnelKey: "visit_meeting",
            featureSlug: GOOGLE_ADS,
            dailyBudgetCents: 500,
          },
        ],
      });
    expect(both.status).toBe(200);

    // The two groups do not pool: $24 of cold email cannot carry $1 of Google
    // Ads over its own floor.
    const pooled = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_meeting", featureSlug: COLD, dailyBudgetCents: 2400 },
          {
            funnelKey: "visit_meeting",
            featureSlug: GOOGLE_ADS,
            dailyBudgetCents: 100,
          },
        ],
      });
    expect(pooled.status).toBe(400);
    expect(pooled.body.error).toContain(GOOGLE_ADS);

    // ...and $5 of Google Ads cannot carry $1 of cold email over the funnel's.
    const other = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_meeting", featureSlug: COLD, dailyBudgetCents: 100 },
          {
            funnelKey: "visit_meeting",
            featureSlug: GOOGLE_ADS,
            dailyBudgetCents: 500,
          },
        ],
      });
    expect(other.status).toBe(400);
    expect(other.body.error).toContain("$24/day");
  });

  it("accepts zero on Google Ads, and a set where everything is zero", async () => {
    const paused = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_form", featureSlug: GOOGLE_ADS, dailyBudgetCents: 0 },
          { funnelKey: "visit_form", featureSlug: COLD, dailyBudgetCents: 0 },
        ],
      });
    expect(paused.status).toBe(200);
    expect(paused.body.dailyBudgetCents).toBe("0.0000000000");

    // Funded, then defunded: stopping is never blocked.
    expect((await setOne("visit_form", GOOGLE_ADS, 500)).status).toBe(200);
    expect((await setOne("visit_form", GOOGLE_ADS, 0)).status).toBe(200);
  });

  it("refuses a channel it prices no floor for, at any amount", async () => {
    for (const cents of [0, 500, 100000]) {
      const res = await setOne("visit_form", "carrier-pigeon-outreach", cents);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("unknown acquisition channel");
    }

    // Nothing was stored on the way to the refusal.
    const read = await request(app).get(funnelReadPath).set(internalHeaders);
    expect(read.body.dailyBudgetCents).toBeNull();
  });
});
