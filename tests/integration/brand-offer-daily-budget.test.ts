/**
 * ONE OFFER's daily ceiling, answerable in one request.
 *
 * An offer-scoped screen shows a fraction: that offer's spend today over the
 * ceiling it is paced against. The numerator became the offer's; the denominator
 * had only one shape available, the brand-wide total — which is about a different
 * thing the moment a brand states a second proposition. It reads correctly today
 * only because every live brand names one offer, a property of the data rather
 * than of the design.
 *
 * The brand-wide read is deliberately UNTOUCHED: several consumers pace and gate
 * real spend on what it means, so this is its own answer rather than a widening
 * of theirs.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { brandFunnelDailyBudgets } from "../../src/db/schema.js";

const orgId = "00000000-0000-0000-0000-0000000b0f01";
const userId = "00000000-0000-0000-0000-0000000b0f99";
const runId = "00000000-0000-0000-0000-0000000b0fbb";
const brandId = "00000000-0000-0000-0000-000000b0fb01";

const COLD = "sales-cold-email-outreach";
const FEEDBACK = "feedback-request-cold-email-outreach";
const OFFER_A = "aaaaaaaa-5555-4555-8555-aaaaaaaaaaaa";
const OFFER_B = "bbbbbbbb-6666-4666-8666-bbbbbbbbbbbb";
const OFFER_UNKNOWN = "cccccccc-7777-4777-8777-cccccccccccc";

const internalHeaders = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const brandReadPath = `/internal/brands/${brandId}/daily-budget`;
const offerReadPath = (offerId: string) =>
  `/internal/brands/${brandId}/offers/${offerId}/daily-budget`;
const userOfferReadPath = (offerId: string) =>
  `/v1/brands/${brandId}/offers/${offerId}/daily-budget`;

const app = createTestApp();

/** Seed a ceiling directly, so a pre-offer (unscoped) state is reachable. */
async function seedCeiling(
  funnelKey: string,
  featureSlug: string,
  offerId: string | null,
  cents: string,
  updatedAt = new Date()
): Promise<void> {
  await db.insert(brandFunnelDailyBudgets).values({
    orgId,
    brandId,
    funnelKey,
    featureSlug,
    offerId,
    dailyBudgetCents: cents,
    updatedAt,
  });
}

async function readOffer(offerId: string) {
  const res = await request(app).get(offerReadPath(offerId)).set(internalHeaders);
  return {
    status: res.status,
    total: res.body.dailyBudgetCents as string | null,
    updatedAt: res.body.updatedAt as string | null,
    funnels: ((res.body.funnels ?? []) as Array<{
      funnelKey: string;
      dailyBudgetCents: string;
    }>).map((f) => [f.funnelKey, f.dailyBudgetCents] as const),
    channels: ((res.body.channels ?? []) as Array<{
      funnelKey: string;
      featureSlug: string;
      dailyBudgetCents: string;
    }>).map(
      (c) => [c.funnelKey, c.featureSlug, c.dailyBudgetCents] as const
    ),
  };
}

async function readBrandTotal(): Promise<string | null> {
  const res = await request(app).get(brandReadPath).set(internalHeaders);
  return res.body.dailyBudgetCents;
}

describe("one offer's daily ceiling", () => {
  const authHeaders = getAuthHeaders(orgId, userId, runId);

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  // --- The answer itself ---

  it("sums the ceilings funding one offer across its channels, in ONE request", async () => {
    await seedCeiling("reply_meeting", COLD, OFFER_A, "4000.0000000000");
    await seedCeiling("reply_meeting", FEEDBACK, OFFER_A, "1000.0000000000");

    const offer = await readOffer(OFFER_A);

    expect(offer.status).toBe(200);
    expect(offer.total).toBe("5000.0000000000");
    // The breakdown is served too, so no caller enumerates the channels itself.
    expect(offer.funnels).toEqual([["reply_meeting", "5000.0000000000"]]);
    expect(offer.channels).toEqual([
      ["reply_meeting", FEEDBACK, "1000.0000000000"],
      ["reply_meeting", COLD, "4000.0000000000"],
    ]);
  });

  it("is consistent with the per-(funnel, channel) figures served for the same offer", async () => {
    await seedCeiling("reply_meeting", COLD, OFFER_A, "4000.0000000000");
    await seedCeiling("visit_form", COLD, OFFER_A, "300.0000000000");

    const offer = await readOffer(OFFER_A);
    const channelSum = offer.channels.reduce(
      (total, [, , cents]) => total + Number(cents),
      0
    );

    expect(Number(offer.total)).toBe(channelSum);
    expect(offer.funnels).toEqual([
      ["reply_meeting", "4000.0000000000"],
      ["visit_form", "300.0000000000"],
    ]);
  });

  it("carries the latest of the ceilings funding it as updatedAt", async () => {
    const older = new Date("2026-08-01T00:00:00.000Z");
    const newer = new Date("2026-08-20T00:00:00.000Z");
    await seedCeiling("reply_meeting", COLD, OFFER_A, "4000.0000000000", older);
    await seedCeiling(
      "reply_meeting",
      FEEDBACK,
      OFFER_A,
      "1000.0000000000",
      newer
    );

    const offer = await readOffer(OFFER_A);
    expect(offer.updatedAt).toBe(newer.toISOString());
  });

  // --- The brand's only offer answers the brand total ---

  it("answers the brand total when it is the brand's only offer", async () => {
    await seedCeiling("reply_meeting", COLD, OFFER_A, "4000.0000000000");
    await seedCeiling("reply_meeting", FEEDBACK, OFFER_A, "1000.0000000000");

    expect(await readOffer(OFFER_A).then((o) => o.total)).toBe(
      await readBrandTotal()
    );
  });

  it("counts a pre-offer UNSCOPED ceiling when it is the brand's only named offer — the live case", async () => {
    // Exactly the live brand (org b645207b-…, brand 75d7e3e8-…, offer
    // d5ecba00-…): a ceiling stated under its offer on the cold-email channel,
    // plus one left UNSCOPED on the feedback-request channel by a write that
    // predates offers. The only brand in the fleet naming an offer at all.
    await seedCeiling("reply_meeting", COLD, OFFER_A, "5000.0000000000");
    await seedCeiling("reply_meeting", FEEDBACK, null, "1000.0000000000");

    const offer = await readOffer(OFFER_A);

    expect(offer.total).toBe("6000.0000000000");
    // No live brand's screen moves: this IS the brand-wide total it shows today.
    expect(offer.total).toBe(await readBrandTotal());
    expect(offer.channels).toEqual([
      ["reply_meeting", FEEDBACK, "1000.0000000000"],
      ["reply_meeting", COLD, "5000.0000000000"],
    ]);
  });

  it("leaves an unscoped ceiling to NEITHER offer once a brand names two", async () => {
    await seedCeiling("reply_meeting", COLD, OFFER_A, "4000.0000000000");
    await seedCeiling("visit_form", COLD, OFFER_B, "300.0000000000");
    await seedCeiling("reply_meeting", FEEDBACK, null, "1000.0000000000");

    // Neither offer is the brand's sole named one, so the unscoped remainder has
    // no honest owner and is attributed to no offer at all.
    expect(await readOffer(OFFER_A).then((o) => o.total)).toBe(
      "4000.0000000000"
    );
    expect(await readOffer(OFFER_B).then((o) => o.total)).toBe(
      "300.0000000000"
    );
    expect(await readBrandTotal()).toBe("5300.0000000000");
  });

  // --- Nothing stated is not zero ---

  it("answers null for an offer that has no ceiling, even beside funded ones", async () => {
    await seedCeiling("reply_meeting", COLD, OFFER_A, "4000.0000000000");

    const offer = await readOffer(OFFER_UNKNOWN);

    expect(offer.status).toBe(200);
    expect(offer.total).toBeNull();
    expect(offer.updatedAt).toBeNull();
    expect(offer.funnels).toEqual([]);
    expect(offer.channels).toEqual([]);
  });

  it("answers null for any offer of a brand funded only at the brand grain", async () => {
    // A brand-level scalar names no offer, so no offer's ceiling is stated —
    // the brand total is NOT invented as one.
    await request(app)
      .patch(`/v1/brands/${brandId}/daily-budget`)
      .set(authHeaders)
      .send({ dailyBudgetCents: 5000 });

    expect(await readBrandTotal()).toBe("5000.0000000000");
    expect(await readOffer(OFFER_A).then((o) => o.total)).toBeNull();
  });

  it("keeps a funded-at-zero offer distinct from an offer with no ceiling", async () => {
    await seedCeiling("visit_form", COLD, OFFER_A, "0.0000000000");

    expect(await readOffer(OFFER_A).then((o) => o.total)).toBe("0.0000000000");
    expect(await readOffer(OFFER_B).then((o) => o.total)).toBeNull();
  });

  // --- Scoping, auth, validation ---

  it("keeps offers of the same brand separate across orgs", async () => {
    await seedCeiling("reply_meeting", COLD, OFFER_A, "4000.0000000000");

    const otherOrg = "00000000-0000-0000-0000-0000000b0f02";
    const res = await request(app)
      .get(offerReadPath(OFFER_A))
      .set({ "X-API-Key": "test-api-key", "x-org-id": otherOrg });

    expect(res.status).toBe(200);
    expect(res.body.dailyBudgetCents).toBeNull();
  });

  it("serves the same answer to the user via the gateway", async () => {
    await seedCeiling("reply_meeting", COLD, OFFER_A, "4000.0000000000");
    await seedCeiling("reply_meeting", FEEDBACK, null, "1000.0000000000");

    const res = await request(app)
      .get(userOfferReadPath(OFFER_A))
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(orgId);
    expect(res.body.brandId).toBe(brandId);
    expect(res.body.offerId).toBe(OFFER_A);
    expect(res.body.dailyBudgetCents).toBe("5000.0000000000");
  });

  it("reads an offer id case-insensitively, as it is stored lower-cased", async () => {
    await seedCeiling("reply_meeting", COLD, OFFER_A, "4000.0000000000");

    const res = await request(app)
      .get(offerReadPath(OFFER_A.toUpperCase()))
      .set(internalHeaders);

    expect(res.body.dailyBudgetCents).toBe("4000.0000000000");
  });

  it("rejects a non-UUID offerId and a non-UUID brandId", async () => {
    const badOffer = await request(app)
      .get(offerReadPath("not-an-offer"))
      .set(internalHeaders);
    expect(badOffer.status).toBe(400);

    const badBrand = await request(app)
      .get(`/internal/brands/not-a-brand/offers/${OFFER_A}/daily-budget`)
      .set(internalHeaders);
    expect(badBrand.status).toBe(400);
  });

  it("requires an org on the internal read", async () => {
    const res = await request(app)
      .get(offerReadPath(OFFER_A))
      .set({ "X-API-Key": "test-api-key" });
    expect(res.status).toBe(400);
  });

  // --- The brand-wide read is untouched ---

  it("leaves the brand-wide reads byte-unaffected", async () => {
    await seedCeiling("reply_meeting", COLD, OFFER_A, "4000.0000000000");
    await seedCeiling("reply_meeting", FEEDBACK, null, "1000.0000000000");

    const funnelView = await request(app)
      .get(`/internal/brands/${brandId}/funnel-budgets`)
      .set(internalHeaders);

    expect(funnelView.body.dailyBudgetCents).toBe("5000.0000000000");
    expect(funnelView.body.funnels).toEqual([
      {
        funnelKey: "reply_meeting",
        dailyBudgetCents: "5000.0000000000",
        updatedAt: expect.any(String),
      },
    ]);
    // The per-offer figure is served on its OWN read, not folded into this one.
    expect(funnelView.body).not.toHaveProperty("offerTotals");
  });
});
