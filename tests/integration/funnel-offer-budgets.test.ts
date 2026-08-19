/**
 * A daily ceiling per (funnel, ACQUISITION CHANNEL, OFFER) — one per campaign.
 *
 * A campaign is (offer x sales funnel x acquisition channel). Keyed on the pair
 * alone, two offers of the same brand selling through the same funnel on the
 * same channel collided on ONE ceiling: funding one silently funded the other,
 * and neither could be stopped without stopping both.
 *
 * The offer is PURELY ADDITIVE. A caller that names none behaves exactly as it
 * did before offers existed, and a caller whose write would be AMBIGUOUS across
 * offers is refused rather than guessed at — the same posture this service
 * already takes for a funnel split across channels.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { brandFunnelDailyBudgets } from "../../src/db/schema.js";

const orgId = "00000000-0000-0000-0000-00000000cf01";
const userId = "00000000-0000-0000-0000-00000000cf99";
const runId = "00000000-0000-0000-0000-00000000cfbb";
const brandId = "00000000-0000-0000-0000-0000000cfb01";

const COLD = "sales-cold-email-outreach";
const FEEDBACK = "sales-feedback-request-outreach";
const OFFER_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OFFER_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const internalHeaders = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const brandReadPath = `/internal/brands/${brandId}/daily-budget`;
const funnelReadPath = `/internal/brands/${brandId}/funnel-budgets`;
const funnelSetPath = `/v1/brands/${brandId}/funnel-budgets`;
const funnelOnePath = (key: string) =>
  `/v1/brands/${brandId}/funnel-budgets/${key}`;

type OfferRow = {
  funnelKey: string;
  featureSlug: string;
  offerId: string | null;
  dailyBudgetCents: string;
};

const app = createTestApp();

/**
 * Seed a ceiling directly, the way the attribution sweep put the live ones
 * there: verbatim, with no minimum enforced. It is the only way to reach the
 * grandfathered state, since the write routes refuse to CREATE a sub-floor
 * ceiling in the first place.
 */
async function seedCeiling(
  funnelKey: string,
  featureSlug: string,
  offerId: string | null,
  cents: string
): Promise<void> {
  await db.insert(brandFunnelDailyBudgets).values({
    orgId,
    brandId,
    funnelKey,
    featureSlug,
    offerId,
    dailyBudgetCents: cents,
    updatedAt: new Date(),
  });
}

async function read() {
  const res = await request(app).get(funnelReadPath).set(internalHeaders);
  return {
    brandTotal: res.body.dailyBudgetCents as string | null,
    funnels: (res.body.funnels as OfferRow[]).map(
      (f) => [f.funnelKey, f.dailyBudgetCents] as const
    ),
    channels: (res.body.channels as OfferRow[]).map(
      (c) => [c.funnelKey, c.featureSlug, c.dailyBudgetCents] as const
    ),
    offers: (res.body.offers as OfferRow[]).map(
      (o) =>
        [o.funnelKey, o.featureSlug, o.offerId, o.dailyBudgetCents] as const
    ),
  };
}

describe("per-offer daily ceilings", () => {
  const authHeaders = getAuthHeaders(orgId, userId, runId);

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  // --- Two offers of one brand, one funnel, one channel ---

  it("funds two offers of the same funnel and channel independently", async () => {
    const res = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          {
            funnelKey: "visit_form",
            featureSlug: COLD,
            offerId: OFFER_A,
            dailyBudgetCents: 600,
          },
          {
            funnelKey: "visit_form",
            featureSlug: COLD,
            offerId: OFFER_B,
            dailyBudgetCents: 400,
          },
        ],
      });
    expect(res.status).toBe(200);

    const view = await read();
    // Two ceilings, addressable one at a time.
    expect(view.offers).toEqual([
      ["visit_form", COLD, OFFER_A, "600.0000000000"],
      ["visit_form", COLD, OFFER_B, "400.0000000000"],
    ]);
    // Everything coarser is their sum, composed by this service.
    expect(view.channels).toEqual([["visit_form", COLD, "1000.0000000000"]]);
    expect(view.funnels).toEqual([["visit_form", "1000.0000000000"]]);
    expect(view.brandTotal).toBe("1000.0000000000");

    const brandRead = await request(app)
      .get(brandReadPath)
      .set(internalHeaders);
    expect(brandRead.body.dailyBudgetCents).toBe("1000.0000000000");
  });

  it("stops paying for one offer without touching the other", async () => {
    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_form", featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 600 },
          { funnelKey: "visit_form", featureSlug: COLD, offerId: OFFER_B, dailyBudgetCents: 400 },
        ],
      });

    const res = await request(app)
      .patch(funnelOnePath("visit_form"))
      .set(authHeaders)
      .send({ featureSlug: COLD, offerId: OFFER_B, dailyBudgetCents: 0 });
    expect(res.status).toBe(200);

    const view = await read();
    expect(view.offers).toEqual([
      ["visit_form", COLD, OFFER_A, "600.0000000000"],
      ["visit_form", COLD, OFFER_B, "0.0000000000"],
    ]);
    expect(view.brandTotal).toBe("600.0000000000");
  });

  it("keeps two offers apart across channels as well as within one", async () => {
    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_form", featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 600 },
          { funnelKey: "visit_form", featureSlug: FEEDBACK, offerId: OFFER_A, dailyBudgetCents: 300 },
          { funnelKey: "visit_form", featureSlug: COLD, offerId: OFFER_B, dailyBudgetCents: 100 },
        ],
      });

    const view = await read();
    expect(view.offers).toEqual([
      ["visit_form", COLD, OFFER_A, "600.0000000000"],
      ["visit_form", COLD, OFFER_B, "100.0000000000"],
      ["visit_form", FEEDBACK, OFFER_A, "300.0000000000"],
    ]);
    expect(view.channels).toEqual([
      ["visit_form", COLD, "700.0000000000"],
      ["visit_form", FEEDBACK, "300.0000000000"],
    ]);
    expect(view.brandTotal).toBe("1000.0000000000");
  });

  // --- A caller that says nothing about offers ---

  it("writes an UNSCOPED ceiling when no offer is named, and re-states it in place", async () => {
    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({ funnels: [{ funnelKey: "visit_form", dailyBudgetCents: 500 }] });

    let view = await read();
    expect(view.offers).toEqual([
      ["visit_form", COLD, null, "500.0000000000"],
    ]);

    // A second offer-less write updates that same ceiling: it must not open a
    // second one beside it.
    const res = await request(app)
      .patch(funnelOnePath("visit_form"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 800 });
    expect(res.status).toBe(200);

    view = await read();
    expect(view.offers).toEqual([
      ["visit_form", COLD, null, "800.0000000000"],
    ]);
    expect(view.brandTotal).toBe("800.0000000000");
  });

  it("addresses the pair's single offer when the caller names none", async () => {
    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_form", featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 500 },
        ],
      });

    const res = await request(app)
      .patch(funnelOnePath("visit_form"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 900 });
    expect(res.status).toBe(200);

    const view = await read();
    expect(view.offers).toEqual([
      ["visit_form", COLD, OFFER_A, "900.0000000000"],
    ]);
  });

  it("leaves the pre-offer read shape untouched for a brand that funds no offer", async () => {
    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_form", dailyBudgetCents: 100 },
          { funnelKey: "visit_signup", dailyBudgetCents: 300 },
        ],
      });

    const res = await request(app).get(funnelReadPath).set(internalHeaders);
    expect(res.body.dailyBudgetCents).toBe("400.0000000000");
    expect(res.body.funnels).toEqual([
      {
        funnelKey: "visit_signup",
        dailyBudgetCents: "300.0000000000",
        updatedAt: expect.any(String),
      },
      {
        funnelKey: "visit_form",
        dailyBudgetCents: "100.0000000000",
        updatedAt: expect.any(String),
      },
    ]);
    expect(res.body.channels).toEqual([
      {
        funnelKey: "visit_signup",
        featureSlug: COLD,
        dailyBudgetCents: "300.0000000000",
        updatedAt: expect.any(String),
      },
      {
        funnelKey: "visit_form",
        featureSlug: COLD,
        dailyBudgetCents: "100.0000000000",
        updatedAt: expect.any(String),
      },
    ]);
  });

  it("removes a ceiling absent from a replace-mode write, offer-scoped or not", async () => {
    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_form", featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 600 },
          { funnelKey: "visit_form", featureSlug: COLD, offerId: OFFER_B, dailyBudgetCents: 400 },
          { funnelKey: "visit_signup", featureSlug: COLD, dailyBudgetCents: 200 },
        ],
      });

    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_form", featureSlug: COLD, offerId: OFFER_B, dailyBudgetCents: 400 },
        ],
      });

    const view = await read();
    // The unscoped visit_signup ceiling is deleted too — `= NULL` matches
    // nothing, so a bad WHERE would silently leave it behind.
    expect(view.offers).toEqual([
      ["visit_form", COLD, OFFER_B, "400.0000000000"],
    ]);
    expect(view.brandTotal).toBe("400.0000000000");
  });

  // --- An ambiguous write is refused, never guessed ---

  it("refuses an offer-less write against a pair funded for two offers", async () => {
    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_form", featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 600 },
          { funnelKey: "visit_form", featureSlug: COLD, offerId: OFFER_B, dailyBudgetCents: 400 },
        ],
      });

    const res = await request(app)
      .patch(funnelOnePath("visit_form"))
      .set(authHeaders)
      .send({ featureSlug: COLD, dailyBudgetCents: 700 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/2 offers/);
    expect(res.body.error).toMatch(/Name the offer you are funding/);

    // Nothing moved.
    const view = await read();
    expect(view.offers).toEqual([
      ["visit_form", COLD, OFFER_A, "600.0000000000"],
      ["visit_form", COLD, OFFER_B, "400.0000000000"],
    ]);
  });

  it("refuses an offer-less whole-set write against a split pair", async () => {
    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_form", featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 600 },
          { funnelKey: "visit_form", featureSlug: COLD, offerId: OFFER_B, dailyBudgetCents: 400 },
        ],
      });

    const res = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [{ funnelKey: "visit_form", featureSlug: COLD, dailyBudgetCents: 700 }],
      });

    expect(res.status).toBe(409);
    const view = await read();
    expect(view.brandTotal).toBe("1000.0000000000");
  });

  it("refuses an offer-less write when an unscoped ceiling sits beside an offer-scoped one", async () => {
    // An UNSCOPED ceiling is one of the two candidates, not a tie-break: which
    // of the two the money is for is exactly the question that has no answer.
    // Seeded, because ONE set may not state a pair both with and without an
    // offer; the state is reached by writing the unscoped ceiling first and
    // opening an offer beside it later.
    await seedCeiling("visit_form", COLD, null, "600.0000000000");
    await request(app)
      .patch(funnelOnePath("visit_form"))
      .set(authHeaders)
      .send({ featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 400 });

    const res = await request(app)
      .patch(funnelOnePath("visit_form"))
      .set(authHeaders)
      .send({ featureSlug: COLD, dailyBudgetCents: 700 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no offer/);
  });

  it("still refuses a channel-less write against a funnel split across channels", async () => {
    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_form", featureSlug: COLD, dailyBudgetCents: 600 },
          { funnelKey: "visit_form", featureSlug: FEEDBACK, dailyBudgetCents: 400 },
        ],
      });

    const res = await request(app)
      .patch(funnelOnePath("visit_form"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 700 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/2 acquisition channels/);
  });

  it("refuses an offer that is not a UUID, before anything is written", async () => {
    const res = await request(app)
      .patch(funnelOnePath("visit_form"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 100, offerId: "the-summer-offer" });
    expect(res.status).toBe(400);

    const view = await read();
    expect(view.offers).toEqual([]);
  });

  // --- The floor and its grandfather still bind the FUNNEL TOTAL ---

  it("judges the minimum on the funnel total, across offers", async () => {
    // $12 + $12 on a $24/day funnel, split across two offers: accepted, because
    // the funnel still spends $24/day.
    const res = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "reply_meeting", featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 1200 },
          { funnelKey: "reply_meeting", featureSlug: COLD, offerId: OFFER_B, dailyBudgetCents: 1200 },
        ],
      });
    expect(res.status).toBe(200);
    expect((await read()).funnels).toEqual([
      ["reply_meeting", "2400.0000000000"],
    ]);
  });

  it("refuses a sub-floor funnel total however it is split across offers", async () => {
    const res = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "reply_meeting", featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 600 },
          { funnelKey: "reply_meeting", featureSlug: COLD, offerId: OFFER_B, dailyBudgetCents: 600 },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/needs at least \$24\/day/);
  });

  it("does not open the grandfather for a funnel already above its floor", async () => {
    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [{ funnelKey: "reply_meeting", featureSlug: COLD, dailyBudgetCents: 2400 }],
      });

    // Opening an offer beside it RAISES the total, which is fine.
    const raised = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 800 });
    expect(raised.status).toBe(200);

    // The stored total is $32, so nothing is grandfathered: a whole-set write
    // that leaves the funnel spending $1/day is refused, even though the ONLY
    // surviving ceiling is offer-scoped.
    const lowered = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "reply_meeting", featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 100 },
        ],
      });
    expect(lowered.status).toBe(400);
    expect(lowered.body.error).toMatch(/needs at least \$24\/day/);
    expect((await read()).funnels).toEqual([
      ["reply_meeting", "3200.0000000000"],
    ]);
  });

  it("lets a grandfathered funnel keep or raise its total while it opens an offer", async () => {
    // The live production shape: a reply-to-meeting funnel funded at $8/day
    // against a $24/day floor, because the ceiling predates the minimum and the
    // attribution sweep carried it over verbatim.
    await seedCeiling("reply_meeting", COLD, null, "800.0000000000");
    expect((await read()).funnels).toEqual([["reply_meeting", "800.0000000000"]]);

    // Adding an offer-scoped ceiling RAISES the funnel total: accepted.
    const raised = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 200 });
    expect(raised.status).toBe(200);
    expect((await read()).funnels).toEqual([["reply_meeting", "1000.0000000000"]]);

    // Lowering the total to another funded sub-floor figure is a NEW statement
    // below the floor, and is refused at the offer grain exactly as it is at
    // the funnel grain.
    const lowered = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 0 });
    expect(lowered.status).toBe(400);
    expect((await read()).funnels).toEqual([["reply_meeting", "1000.0000000000"]]);
  });

  it("still lets a grandfathered funnel be defunded entirely", async () => {
    await seedCeiling("reply_meeting", COLD, null, "800.0000000000");

    const res = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ featureSlug: COLD, dailyBudgetCents: 0 });
    expect(res.status).toBe(200);
    expect((await read()).brandTotal).toBe("0.0000000000");
  });
});
