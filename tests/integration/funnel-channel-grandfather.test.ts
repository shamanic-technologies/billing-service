/**
 * The product minimum, and the grandfather that lets a funnel funded below it be
 * kept or raised, now bind the FUNNEL TOTAL rather than any single
 * (funnel, acquisition-channel) pair.
 *
 * Two things must both hold, and they pull in opposite directions:
 *   - a customer splitting one funded funnel across two channels must not be
 *     refused because each half is under a floor the whole clears;
 *   - the grandfather must not silently re-open for a funnel that was already
 *     above the floor, whatever the split underneath looks like.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { brandFunnelDailyBudgets } from "../../src/db/schema.js";

const orgId = "00000000-0000-0000-0000-00000000ce01";
const userId = "00000000-0000-0000-0000-00000000ce99";
const runId = "00000000-0000-0000-0000-00000000cebb";
const brandId = "00000000-0000-0000-0000-0000000ceb01";

const COLD = "sales-cold-email-outreach";
const FEEDBACK = "sales-feedback-request-outreach";

const internalHeaders = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const funnelReadPath = `/internal/brands/${brandId}/funnel-budgets`;
const funnelOnePath = (key: string) =>
  `/v1/brands/${brandId}/funnel-budgets/${key}`;

const app = createTestApp();

/**
 * The live production shape: a reply-to-meeting funnel funded below its $24/day
 * minimum, because the ceiling predates the minimum and the attribution sweep
 * carried it over verbatim. Seeded directly, exactly as it got there.
 */
async function seedCeiling(featureSlug: string, cents: string): Promise<void> {
  await db.insert(brandFunnelDailyBudgets).values({
    orgId,
    brandId,
    funnelKey: "reply_meeting",
    featureSlug,
    dailyBudgetCents: cents,
    updatedAt: new Date(),
  });
}

async function funnelTotal(): Promise<string | undefined> {
  const read = await request(app).get(funnelReadPath).set(internalHeaders);
  return read.body.funnels[0]?.dailyBudgetCents;
}

describe("the minimum and its grandfather bind the funnel total", () => {
  const authHeaders = getAuthHeaders(orgId, userId, runId);

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("splits an $8/day grandfathered funnel across two channels", async () => {
    await seedCeiling(COLD, "800.0000000000");

    // $8 -> $6 cold + $2 feedback keeps the funnel at $8: nothing about what the
    // funnel spends per day changed, so it is neither a raise nor a new
    // sub-minimum statement.
    const res = await request(app)
      .put(`/v1/brands/${brandId}/funnel-budgets`)
      .set(authHeaders)
      .send({
        funnels: [
          {
            funnelKey: "reply_meeting",
            featureSlug: COLD,
            dailyBudgetCents: 600,
          },
          {
            funnelKey: "reply_meeting",
            featureSlug: FEEDBACK,
            dailyBudgetCents: 200,
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(await funnelTotal()).toBe("800.0000000000");
  });

  it("raises a grandfathered funnel by opening a second channel", async () => {
    await seedCeiling(COLD, "800.0000000000");

    const res = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ featureSlug: FEEDBACK, dailyBudgetCents: 200 });
    expect(res.status).toBe(200);
    expect(await funnelTotal()).toBe("1000.0000000000");
  });

  it("refuses lowering a grandfathered funnel's TOTAL while still under the floor", async () => {
    await seedCeiling(COLD, "800.0000000000");

    const res = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ featureSlug: COLD, dailyBudgetCents: 500 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("$8/day");
    expect(await funnelTotal()).toBe("800.0000000000");
  });

  it("still lets a grandfathered funnel be defunded to zero", async () => {
    await seedCeiling(COLD, "800.0000000000");

    const res = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ featureSlug: COLD, dailyBudgetCents: 0 });
    expect(res.status).toBe(200);
    expect(await funnelTotal()).toBe("0.0000000000");
  });

  it("does NOT open a grandfather for a funnel that was above the floor", async () => {
    await seedCeiling(COLD, "2400.0000000000");

    // Splitting it in half is fine — the total is untouched.
    const split = await request(app)
      .put(`/v1/brands/${brandId}/funnel-budgets`)
      .set(authHeaders)
      .send({
        funnels: [
          {
            funnelKey: "reply_meeting",
            featureSlug: COLD,
            dailyBudgetCents: 1200,
          },
          {
            funnelKey: "reply_meeting",
            featureSlug: FEEDBACK,
            dailyBudgetCents: 1200,
          },
        ],
      });
    expect(split.status).toBe(200);
    expect(await funnelTotal()).toBe("2400.0000000000");

    // Dropping the total under the floor is a fresh sub-minimum statement, and
    // the split does not buy it a grandfather.
    const lower = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ featureSlug: FEEDBACK, dailyBudgetCents: 100 });
    expect(lower.status).toBe(400);
    expect(await funnelTotal()).toBe("2400.0000000000");
  });

  it("spends the grandfather once the funnel total reaches the minimum", async () => {
    await seedCeiling(COLD, "800.0000000000");

    const raise = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ featureSlug: COLD, dailyBudgetCents: 2400 });
    expect(raise.status).toBe(200);

    const lower = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ featureSlug: COLD, dailyBudgetCents: 800 });
    expect(lower.status).toBe(400);
    expect(await funnelTotal()).toBe("2400.0000000000");
  });
});
