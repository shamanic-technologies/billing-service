/**
 * A daily ceiling is stated and read per CAMPAIGN — (offer x leg x channel) —
 * with no sales funnel (migration 0047). Additive: every funnel-keyed read keeps
 * answering what it answered, and a funnel-less ceiling counts in every total
 * while never appearing in a funnel-grain array.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { brandFunnelDailyBudgets } from "../../src/db/schema.js";

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
const funnelReadPath = `/internal/brands/${brandId}/funnel-budgets`;

const app = createTestApp();

async function seed(
  funnelKey: string | null,
  featureSlug: string,
  offerId: string | null,
  legKey: string | null,
  cents: string
) {
  await db.insert(brandFunnelDailyBudgets).values({
    orgId,
    brandId,
    funnelKey,
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
  return (await db.select().from(brandFunnelDailyBudgets)).filter(
    (r) => r.brandId === brandId
  );
}

describe("a daily ceiling per campaign, with no sales funnel", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("writes then reads a ceiling by (offer, leg, channel) with no funnel", async () => {
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
    expect(rows[0].funnelKey).toBeNull();

    // Counts in every total; never rendered in a funnel-grain array.
    expect(await brandTotal()).toBe("2500.0000000000");
    const funnels = await request(app).get(funnelReadPath).set(internalHeaders);
    expect(funnels.body).toEqual({
      brandId,
      dailyBudgetCents: "2500.0000000000",
      funnels: [],
      channels: [],
      offers: [],
      legs: [],
    });

    const list = await request(app).get(campaignsPath).set(internalHeaders);
    expect(list.body.dailyBudgetCents).toBe("2500.0000000000");
    expect(list.body.campaigns).toEqual([
      {
        offerId: OFFER_A,
        legKey: LEG_REPLY,
        featureSlug: COLD,
        dailyBudgetCents: "2500.0000000000",
        updatedAt: expect.any(String),
      },
    ]);
  });

  it("re-stating a funnel-keyed campaign updates that row in place (funnel reads unchanged in shape)", async () => {
    await seed("reply_meeting", COLD, OFFER_A, LEG_REPLY, "1000");
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
    expect(rows[0].funnelKey).toBe("reply_meeting");
    expect(rows[0].dailyBudgetCents).toBe("3000.0000000000");
    expect(await brandTotal()).toBe("3000.0000000000");
  });

  it("consolidates one campaign held under several funnels into one row", async () => {
    await seed("visit_signup", COLD, OFFER_A, LEG_VISIT, "900");
    await seed("visit_form", COLD, OFFER_A, LEG_VISIT, "600");
    // The read sums them, so it agrees with the brand total counting both.
    expect(await readOne(OFFER_A, LEG_VISIT, COLD)).toBe("1500.0000000000");
    expect(await brandTotal()).toBe("1500.0000000000");

    await put({
      offerId: OFFER_A,
      legKey: LEG_VISIT,
      featureSlug: COLD,
      dailyBudgetCents: 1200,
    });
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].funnelKey).toBe("visit_signup");
    expect(await readOne(OFFER_A, LEG_VISIT, COLD)).toBe("1200.0000000000");
    expect(await brandTotal()).toBe("1200.0000000000");
  });

  it("adopts a pre-offer / pre-leg ceiling instead of opening a second one beside it", async () => {
    await seed("reply_meeting", COLD, null, null, "800");
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
      funnelKey: "reply_meeting",
      offerId: OFFER_A,
      legKey: LEG_REPLY,
      dailyBudgetCents: "1000.0000000000",
    });
    expect(await brandTotal()).toBe("1000.0000000000");
  });

  it("does not claim an unscoped ceiling when the brand names another offer", async () => {
    await seed("reply_meeting", COLD, OFFER_B, LEG_REPLY, "800");
    await seed("visit_form", COLD, null, LEG_VISIT, "900");
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

  it("a funnel-keyed write naming the same campaign adopts the funnel-less ceiling", async () => {
    await put({
      offerId: OFFER_A,
      legKey: LEG_REPLY,
      featureSlug: COLD,
      dailyBudgetCents: 1000,
    });
    const res = await request(app)
      .patch(`/v1/brands/${brandId}/funnel-budgets/reply_meeting`)
      .set(getAuthHeaders(orgId, userId, runId))
      .send({
        dailyBudgetCents: 1500,
        featureSlug: COLD,
        offerId: OFFER_A,
        legKey: LEG_REPLY,
      });
    expect(res.status).toBe(200);
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].funnelKey).toBe("reply_meeting");
    expect(await brandTotal()).toBe("1500.0000000000");
  });

  it("a whole-set funnel write leaves an unrelated funnel-less ceiling alone", async () => {
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
    const res = await request(app)
      .put(`/v1/brands/${brandId}/funnel-budgets`)
      .set(getAuthHeaders(orgId, userId, runId))
      .send({
        funnels: [
          {
            funnelKey: "visit_signup",
            featureSlug: COLD,
            offerId: OFFER_A,
            legKey: LEG_VISIT,
            dailyBudgetCents: 800,
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.dailyBudgetCents).toBe("1800.0000000000");
    expect(res.body.legs).toHaveLength(1);
    expect(await readOne(OFFER_A, LEG_REPLY, COLD)).toBe("1000.0000000000");
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

  it("reads null campaigns and the brand scalar total for a brand never funded per campaign", async () => {
    const list = await request(app).get(campaignsPath).set(internalHeaders);
    expect(list.body).toEqual({ brandId, dailyBudgetCents: null, campaigns: [] });
  });
});
