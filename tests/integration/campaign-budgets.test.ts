/**
 * A daily ceiling is stated and read per CAMPAIGN — (offer x leg x channel).
 * The sales funnel is gone from this service (migration 0048): no route
 * accepts one, no row carries one, and every total is the sum of the campaigns.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  brandDailyBudgetChanges,
  brandDailyBudgets,
  campaignDailyBudgets,
} from "../../src/db/schema.js";

const orgId = "00000000-0000-0000-0000-0000000047e1";
const userId = "00000000-0000-0000-0000-0000000047e9";
const runId = "00000000-0000-0000-0000-0000000047eb";
const brandId = "00000000-0000-0000-0000-000000047e01";

const COLD = "sales-cold-email-outreach";
const BOOKING = "ai-meeting-booking";
const OFFER_A = "aaaaaaaa-1147-4147-8147-aaaaaaaaaaaa";
const OFFER_B = "bbbbbbbb-2247-4247-8247-bbbbbbbbbbbb";
const LEG_REPLY = "start_to_conversation";
const LEG_VISIT = "start_to_website_visit";

const internalHeaders = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const campaignPath = `/v1/brands/${brandId}/campaign-budget`;
const campaignsPath = `/internal/brands/${brandId}/campaign-budgets`;
const internalCampaignPath = `/internal/brands/${brandId}/campaign-budget`;
const brandTotalPath = `/internal/brands/${brandId}/daily-budget`;

const app = createTestApp();

async function seed(
  featureSlug: string,
  offerId: string | null,
  legKey: string | null,
  cents: string
) {
  await db.insert(campaignDailyBudgets).values({
    orgId,
    brandId,
    featureSlug,
    offerId,
    legKey,
    dailyBudgetCents: cents,
    updatedAt: new Date(),
  });
}

function put(body: Record<string, unknown>) {
  return request(app)
    .put(campaignPath)
    .set(getAuthHeaders(orgId, userId, runId))
    .send(body);
}

async function readOne(offerId: string, legKey: string, featureSlug: string) {
  const res = await request(app)
    .get(internalCampaignPath)
    .query({ offerId, legKey, featureSlug })
    .set(internalHeaders);
  expect(res.status).toBe(200);
  return res.body.dailyBudgetCents as string | null;
}

async function brandTotal() {
  const res = await request(app).get(brandTotalPath).set(internalHeaders);
  return res.body.dailyBudgetCents as string | null;
}

async function storedRows() {
  return (await db.select().from(campaignDailyBudgets)).filter(
    (r) => r.brandId === brandId
  );
}

describe("a daily ceiling per campaign", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("writes then reads a ceiling by (offer, leg, channel)", async () => {
    const res = await put({
      offerId: OFFER_A,
      legKey: LEG_REPLY,
      featureSlug: COLD,
      dailyBudgetCents: 2500,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      offerId: OFFER_A,
      legKey: LEG_REPLY,
      featureSlug: COLD,
      dailyBudgetCents: "2500.0000000000",
      brandDailyBudgetCents: "2500.0000000000",
    });

    expect(await readOne(OFFER_A, LEG_REPLY, COLD)).toBe("2500.0000000000");
    // A different campaign of the same brand has no ceiling: null, never 0.
    expect(await readOne(OFFER_A, LEG_VISIT, COLD)).toBeNull();

    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("funnelKey");

    expect(await brandTotal()).toBe("2500.0000000000");

    const list = await request(app).get(campaignsPath).set(internalHeaders);
    expect(list.body).toEqual({
      brandId,
      dailyBudgetCents: "2500.0000000000",
      campaigns: [
        {
          offerId: OFFER_A,
          legKey: LEG_REPLY,
          featureSlug: COLD,
          dailyBudgetCents: "2500.0000000000",
          updatedAt: expect.any(String),
        },
      ],
    });
  });

  it("re-stating a campaign updates its row in place", async () => {
    await seed(COLD, OFFER_A, LEG_REPLY, "1000");
    expect(await readOne(OFFER_A, LEG_REPLY, COLD)).toBe("1000.0000000000");

    const res = await put({
      offerId: OFFER_A,
      legKey: LEG_REPLY,
      featureSlug: COLD,
      dailyBudgetCents: 3000,
    });
    expect(res.status).toBe(200);

    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].dailyBudgetCents).toBe("3000.0000000000");
    expect(await brandTotal()).toBe("3000.0000000000");
  });

  it("adopts a pre-offer / pre-leg ceiling instead of opening a second one beside it", async () => {
    await seed(COLD, null, null, "800");
    expect(await readOne(OFFER_A, LEG_REPLY, COLD)).toBe("800.0000000000");

    await put({
      offerId: OFFER_A,
      legKey: LEG_REPLY,
      featureSlug: COLD,
      dailyBudgetCents: 1000,
    });
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      offerId: OFFER_A,
      legKey: LEG_REPLY,
      dailyBudgetCents: "1000.0000000000",
    });
    expect(await brandTotal()).toBe("1000.0000000000");
  });

  it("does not claim an unscoped ceiling when the brand names another offer", async () => {
    await seed(COLD, OFFER_B, LEG_REPLY, "800");
    await seed(COLD, null, LEG_VISIT, "900");
    expect(await readOne(OFFER_A, LEG_VISIT, COLD)).toBeNull();

    await put({
      offerId: OFFER_A,
      legKey: LEG_VISIT,
      featureSlug: COLD,
      dailyBudgetCents: 800,
    });
    expect(await storedRows()).toHaveLength(3);
    expect(await brandTotal()).toBe("2500.0000000000");
  });

  it("leaves other campaigns untouched", async () => {
    await put({
      offerId: OFFER_A,
      legKey: LEG_REPLY,
      featureSlug: BOOKING,
      dailyBudgetCents: 0,
    });
    await put({
      offerId: OFFER_A,
      legKey: LEG_REPLY,
      featureSlug: COLD,
      dailyBudgetCents: 1000,
    });
    const res = await put({
      offerId: OFFER_A,
      legKey: LEG_VISIT,
      featureSlug: COLD,
      dailyBudgetCents: 800,
    });
    expect(res.status).toBe(200);
    expect(res.body.brandDailyBudgetCents).toBe("1800.0000000000");
    expect(res.body.campaigns).toHaveLength(3);
    expect(await readOne(OFFER_A, LEG_REPLY, COLD)).toBe("1000.0000000000");
  });

  it("judges the channel floor on the channel TOTAL, with the grandfather", async () => {
    // $4 + $4 on an $8/day channel: the channel clears its floor.
    expect(
      (await put({ offerId: OFFER_A, legKey: LEG_REPLY, featureSlug: COLD, dailyBudgetCents: 0 })).status
    ).toBe(200);
    await seed(COLD, OFFER_A, LEG_VISIT, "400");
    const split = await put({
      offerId: OFFER_A,
      legKey: LEG_REPLY,
      featureSlug: COLD,
      dailyBudgetCents: 400,
    });
    expect(split.status).toBe(200);

    // A channel stored at $8 cannot be lowered to a funded $5.
    const lowered = await put({
      offerId: OFFER_A,
      legKey: LEG_REPLY,
      featureSlug: COLD,
      dailyBudgetCents: 100,
    });
    expect(lowered.status).toBe(400);
    expect(lowered.body.error).toContain("$8/day");

    // A channel ALREADY below its floor ($5) may be kept or raised, not lowered.
    await cleanTestData();
    await seed(COLD, OFFER_A, LEG_REPLY, "500");
    for (const [cents, status] of [
      [500, 200],
      [600, 200],
      [400, 400],
      [0, 200],
    ] as const) {
      const res = await put({
        offerId: OFFER_A,
        legKey: LEG_REPLY,
        featureSlug: COLD,
        dailyBudgetCents: cents,
      });
      expect(res.status).toBe(status);
    }
  });

  it("refuses a funded channel below its published floor, and an incomplete address", async () => {
    const low = await put({
      offerId: OFFER_A,
      legKey: LEG_REPLY,
      featureSlug: COLD,
      dailyBudgetCents: 300,
    });
    expect(low.status).toBe(400);
    expect(low.body.error).toContain("$8/day");

    const unknown = await put({
      offerId: OFFER_A,
      legKey: LEG_REPLY,
      featureSlug: "carrier-pigeon-outreach",
      dailyBudgetCents: 1000,
    });
    expect(unknown.status).toBe(400);

    const noLeg = await put({
      offerId: OFFER_A,
      featureSlug: COLD,
      dailyBudgetCents: 1000,
    });
    expect(noLeg.status).toBe(400);

    const badQuery = await request(app)
      .get(internalCampaignPath)
      .query({ offerId: OFFER_A, featureSlug: COLD })
      .set(internalHeaders);
    expect(badQuery.status).toBe(400);
    expect(await storedRows()).toHaveLength(0);
  });

  it("retires the brand-level scalar on the first ceiling, then refuses a brand-level write (409)", async () => {
    await db.insert(brandDailyBudgets).values({
      orgId,
      brandId,
      dailyBudgetCents: "7000",
    });
    expect(await brandTotal()).toBe("7000.0000000000");

    await put({
      offerId: OFFER_A,
      legKey: LEG_REPLY,
      featureSlug: COLD,
      dailyBudgetCents: 1000,
    });
    expect(
      (await db.select().from(brandDailyBudgets)).filter((r) => r.brandId === brandId)
    ).toHaveLength(0);
    expect(await brandTotal()).toBe("1000.0000000000");

    const history = (await db.select().from(brandDailyBudgetChanges)).filter(
      (r) => r.brandId === brandId
    );
    expect(history.map((h) => h.dailyBudgetCents)).toEqual(["1000.0000000000"]);

    const scalar = await request(app)
      .patch(`/v1/brands/${brandId}/daily-budget`)
      .set(getAuthHeaders(orgId, userId, runId))
      .send({ dailyBudgetCents: 5000 });
    expect(scalar.status).toBe(409);
    expect(scalar.body.error).toContain("per campaign");
  });

  it("reads null campaigns and the brand scalar total for a brand never funded per campaign", async () => {
    const list = await request(app).get(campaignsPath).set(internalHeaders);
    expect(list.body).toEqual({ brandId, dailyBudgetCents: null, campaigns: [] });
  });
});
