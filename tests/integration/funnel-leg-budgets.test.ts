/**
 * A daily ceiling is stated and read for the LEG a campaign is bought for.
 *
 * A campaign is (brand, offer, acquisition channel, LEG) — the leg is what the
 * customer buys, and one leg belongs to SEVERAL sales funnels, so the funnel is
 * becoming a way of READING legs rather than the unit anything is keyed on.
 * Migration 0039 puts the leg in the key; this is the ADDITIVE half, so every
 * existing read still answers what it answers today and nothing became required.
 *
 * The precedence between a leg-keyed ceiling and a leg-less one describing the
 * same money is stated once: the leg-keyed one REPLACES it. They are never
 * summed and never both stored.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { brandFunnelDailyBudgets } from "../../src/db/schema.js";

const orgId = "00000000-0000-0000-0000-0000000019e1";
const userId = "00000000-0000-0000-0000-0000000019e9";
const runId = "00000000-0000-0000-0000-0000000019eb";
const brandId = "00000000-0000-0000-0000-000000019e01";

const COLD = "sales-cold-email-outreach";
const FEEDBACK = "feedback-request-cold-email-outreach";
const OFFER_A = "aaaaaaaa-1119-4119-8119-aaaaaaaaaaaa";
const OFFER_B = "bbbbbbbb-2229-4229-8229-bbbbbbbbbbbb";

// features-service mints these; billing stores them opaque and never parses them.
const LEG_BOOKED = "conversation_to_meeting_booked";
const LEG_ATTENDED = "meeting_booked_to_meeting_attended";

const internalHeaders = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const funnelReadPath = `/internal/brands/${brandId}/funnel-budgets`;
const funnelSetPath = `/v1/brands/${brandId}/funnel-budgets`;
const funnelOnePath = (key: string) =>
  `/v1/brands/${brandId}/funnel-budgets/${key}`;
const legReadPath = (legKey: string) =>
  `/internal/brands/${brandId}/legs/${legKey}/daily-budget`;

type LegRow = {
  funnelKey: string;
  featureSlug: string;
  offerId: string | null;
  legKey: string | null;
  dailyBudgetCents: string;
};

const app = createTestApp();

async function seedCeiling(
  funnelKey: string,
  featureSlug: string,
  offerId: string | null,
  legKey: string | null,
  cents: string
): Promise<void> {
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

async function read() {
  const res = await request(app).get(funnelReadPath).set(internalHeaders);
  return {
    brandTotal: res.body.dailyBudgetCents as string | null,
    funnels: (res.body.funnels as LegRow[]).map(
      (f) => [f.funnelKey, f.dailyBudgetCents] as const
    ),
    channels: (res.body.channels as LegRow[]).map(
      (c) => [c.funnelKey, c.featureSlug, c.dailyBudgetCents] as const
    ),
    offers: (res.body.offers as LegRow[]).map(
      (o) =>
        [o.funnelKey, o.featureSlug, o.offerId, o.dailyBudgetCents] as const
    ),
    legs: (res.body.legs as LegRow[]).map(
      (l) =>
        [
          l.funnelKey,
          l.featureSlug,
          l.offerId,
          l.legKey,
          l.dailyBudgetCents,
        ] as const
    ),
  };
}

describe("a ceiling states the funnel leg its campaign is bought for", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("states a leg-keyed ceiling and reads it back at every grain", async () => {
    const written = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(getAuthHeaders(orgId, userId, runId))
      .send({
        dailyBudgetCents: 3000,
        featureSlug: COLD,
        offerId: OFFER_A,
        legKey: LEG_BOOKED,
      });
    expect(written.status).toBe(200);
    expect(written.body.legs).toEqual([
      {
        funnelKey: "reply_meeting",
        featureSlug: COLD,
        offerId: OFFER_A,
        legKey: LEG_BOOKED,
        dailyBudgetCents: "3000.0000000000",
        updatedAt: expect.any(String),
      },
    ]);

    const view = await read();
    expect(view.brandTotal).toBe("3000.0000000000");
    expect(view.funnels).toEqual([["reply_meeting", "3000.0000000000"]]);
    expect(view.channels).toEqual([
      ["reply_meeting", COLD, "3000.0000000000"],
    ]);
    expect(view.offers).toEqual([
      ["reply_meeting", COLD, OFFER_A, "3000.0000000000"],
    ]);
    expect(view.legs).toEqual([
      ["reply_meeting", COLD, OFFER_A, LEG_BOOKED, "3000.0000000000"],
    ]);

    // And on its own read, the money that paces exactly this campaign.
    const leg = await request(app)
      .get(legReadPath(LEG_BOOKED))
      .set(internalHeaders);
    expect(leg.status).toBe(200);
    expect(leg.body.legKey).toBe(LEG_BOOKED);
    expect(leg.body.dailyBudgetCents).toBe("3000.0000000000");
    expect(leg.body.updatedAt).toEqual(expect.any(String));
    expect(leg.body.channels).toEqual([
      {
        funnelKey: "reply_meeting",
        featureSlug: COLD,
        dailyBudgetCents: "3000.0000000000",
        updatedAt: expect.any(String),
      },
    ]);
  });

  it("leaves a leg-less brand answering exactly what it answers today", async () => {
    await request(app)
      .put(funnelSetPath)
      .set(getAuthHeaders(orgId, userId, runId))
      .send({
        funnels: [
          { funnelKey: "reply_meeting", dailyBudgetCents: 2400 },
          { funnelKey: "visit_signup", dailyBudgetCents: 100 },
        ],
      })
      .expect(200);

    const view = await read();
    expect(view.brandTotal).toBe("2500.0000000000");
    expect(view.funnels).toEqual([
      ["reply_meeting", "2400.0000000000"],
      ["visit_signup", "100.0000000000"],
    ]);
    expect(view.offers).toEqual([
      ["reply_meeting", COLD, null, "2400.0000000000"],
      ["visit_signup", COLD, null, "100.0000000000"],
    ]);
    // The stored grain simply carries no leg. Nothing became required.
    expect(view.legs.map((l) => l[3])).toEqual([null, null]);
  });

  it("REPLACES the triple's leg-less ceiling when a leg is named — never sums both", async () => {
    await seedCeiling("reply_meeting", COLD, OFFER_A, null, "4000.0000000000");

    await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(getAuthHeaders(orgId, userId, runId))
      .send({
        dailyBudgetCents: 4000,
        featureSlug: COLD,
        offerId: OFFER_A,
        legKey: LEG_BOOKED,
      })
      .expect(200);

    const view = await read();
    // $40 re-stated as $40, not $80.
    expect(view.brandTotal).toBe("4000.0000000000");
    expect(view.legs).toEqual([
      ["reply_meeting", COLD, OFFER_A, LEG_BOOKED, "4000.0000000000"],
    ]);
  });

  it("does not adopt when the triple is already split across named legs", async () => {
    await seedCeiling(
      "reply_meeting",
      COLD,
      OFFER_A,
      LEG_BOOKED,
      "2400.0000000000"
    );
    await seedCeiling("reply_meeting", COLD, OFFER_A, null, "600.0000000000");

    await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(getAuthHeaders(orgId, userId, runId))
      .send({
        dailyBudgetCents: 2400,
        featureSlug: COLD,
        offerId: OFFER_A,
        legKey: LEG_ATTENDED,
      })
      .expect(200);

    const view = await read();
    // The leg-less remainder has no unambiguous owner, so nothing is attributed.
    expect(view.brandTotal).toBe("5400.0000000000");
    expect(view.legs.map((l) => l[3])).toEqual([
      null,
      LEG_BOOKED,
      LEG_ATTENDED,
    ]);
  });

  it("resolves a leg-less write onto the triple's single leg, in place", async () => {
    await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(getAuthHeaders(orgId, userId, runId))
      .send({ dailyBudgetCents: 2400, featureSlug: COLD, legKey: LEG_BOOKED })
      .expect(200);

    // A caller that predates legs re-states the same ceiling and must not open a
    // second row beside it.
    await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(getAuthHeaders(orgId, userId, runId))
      .send({ dailyBudgetCents: 3000, featureSlug: COLD })
      .expect(200);

    const view = await read();
    expect(view.brandTotal).toBe("3000.0000000000");
    expect(view.legs).toEqual([
      ["reply_meeting", COLD, null, LEG_BOOKED, "3000.0000000000"],
    ]);
  });

  it("refuses (409) a leg-less write against a triple split across legs", async () => {
    await seedCeiling(
      "reply_meeting",
      COLD,
      null,
      LEG_BOOKED,
      "2400.0000000000"
    );
    await seedCeiling(
      "reply_meeting",
      COLD,
      null,
      LEG_ATTENDED,
      "2400.0000000000"
    );

    const res = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(getAuthHeaders(orgId, userId, runId))
      .send({ dailyBudgetCents: 5000, featureSlug: COLD });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/2 funnel legs/);
  });

  it("refuses (400) a set stating one triple both with and without a leg", async () => {
    const res = await request(app)
      .put(funnelSetPath)
      .set(getAuthHeaders(orgId, userId, runId))
      .send({
        funnels: [
          {
            funnelKey: "reply_meeting",
            featureSlug: COLD,
            legKey: LEG_BOOKED,
            dailyBudgetCents: 2400,
          },
          {
            funnelKey: "reply_meeting",
            featureSlug: COLD,
            dailyBudgetCents: 600,
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/with and without a funnel leg/);
  });

  it("refuses (400) an empty leg id", async () => {
    const res = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(getAuthHeaders(orgId, userId, runId))
      .send({ dailyBudgetCents: 2400, featureSlug: COLD, legKey: "   " });

    expect(res.status).toBe(400);
  });

  it("keeps the product minimum binding the FUNNEL total across legs", async () => {
    // $12 + $12 on a $24/day funnel is accepted split across legs, exactly as it
    // is split across channels — the split changes nothing about what the funnel
    // spends per day.
    await request(app)
      .put(funnelSetPath)
      .set(getAuthHeaders(orgId, userId, runId))
      .send({
        funnels: [
          {
            funnelKey: "reply_meeting",
            featureSlug: COLD,
            legKey: LEG_BOOKED,
            dailyBudgetCents: 1200,
          },
          {
            funnelKey: "reply_meeting",
            featureSlug: COLD,
            legKey: LEG_ATTENDED,
            dailyBudgetCents: 1200,
          },
        ],
      })
      .expect(200);

    // ...and a leg-keyed set that leaves the funnel under its floor is refused,
    // with the minimum unmoved.
    const res = await request(app)
      .put(funnelSetPath)
      .set(getAuthHeaders(orgId, userId, runId))
      .send({
        funnels: [
          {
            funnelKey: "reply_meeting",
            featureSlug: COLD,
            legKey: LEG_BOOKED,
            dailyBudgetCents: 500,
          },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/\$24\/day/);
  });

  it("counts a leg-less ceiling for a leg only while that leg is the brand's sole named one", async () => {
    await seedCeiling("reply_meeting", COLD, null, null, "1000.0000000000");
    await seedCeiling(
      "visit_signup",
      FEEDBACK,
      OFFER_B,
      LEG_BOOKED,
      "500.0000000000"
    );

    const sole = await request(app)
      .get(legReadPath(LEG_BOOKED))
      .set(internalHeaders);
    // Sole named leg → the brand's money has one campaign-owner, so its total is
    // the brand's, which is what keeps a live brand's screen on today's number.
    expect(sole.body.dailyBudgetCents).toBe("1500.0000000000");

    await seedCeiling(
      "visit_form",
      COLD,
      OFFER_A,
      LEG_ATTENDED,
      "100.0000000000"
    );

    const split = await request(app)
      .get(legReadPath(LEG_BOOKED))
      .set(internalHeaders);
    // Two named legs → the leg-less remainder belongs to neither.
    expect(split.body.dailyBudgetCents).toBe("500.0000000000");
  });

  it("answers null for a leg with no ceiling — never 0, never the brand total", async () => {
    await seedCeiling(
      "reply_meeting",
      COLD,
      OFFER_A,
      LEG_BOOKED,
      "2400.0000000000"
    );

    const res = await request(app)
      .get(legReadPath(LEG_ATTENDED))
      .set(internalHeaders);
    expect(res.status).toBe(200);
    expect(res.body.dailyBudgetCents).toBeNull();
    expect(res.body.updatedAt).toBeNull();
    expect(res.body.funnels).toEqual([]);
    expect(res.body.legs).toEqual([]);
  });

  it("serves the user read of one leg through the gateway", async () => {
    await seedCeiling(
      "reply_meeting",
      COLD,
      OFFER_A,
      LEG_BOOKED,
      "2400.0000000000"
    );

    const res = await request(app)
      .get(`/v1/brands/${brandId}/legs/${LEG_BOOKED}/daily-budget`)
      .set(getAuthHeaders(orgId, userId, runId));

    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(orgId);
    expect(res.body.legKey).toBe(LEG_BOOKED);
    expect(res.body.dailyBudgetCents).toBe("2400.0000000000");
  });

  it("stores a leg id it knows nothing about, opaque and unparsed", async () => {
    const res = await request(app)
      .patch(funnelOnePath("visit_signup"))
      .set(getAuthHeaders(orgId, userId, runId))
      .send({
        dailyBudgetCents: 100,
        featureSlug: COLD,
        legKey: "a_leg_billing_has_never_heard_of",
      });

    expect(res.status).toBe(200);
    expect(res.body.legs[0].legKey).toBe("a_leg_billing_has_never_heard_of");
  });
});
