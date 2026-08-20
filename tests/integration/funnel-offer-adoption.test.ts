/**
 * A named offer ADOPTS the pre-offer unscoped ceiling of its own campaign.
 *
 * Resolution shipped in one direction with 0037: a write that names NO offer
 * reads the pair's unscoped ceiling as the money of its only offer and updates
 * it in place. The mirror was missing, so the offer-scoped settings page stored
 * a SECOND row for the same campaign and the per-funnel figure — a SUM — counted
 * the customer's money twice. One live brand was authorized at $90/day on $50 of
 * funding while both of its settings fields showed the right amount.
 *
 * The rule only fires when the unscoped ceiling is the pair's SOLE one: a pair
 * already split across named offers has no unambiguous owner for an unscoped
 * remainder, and no attribution is invented there.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { brandFunnelDailyBudgets } from "../../src/db/schema.js";

const orgId = "00000000-0000-0000-0000-00000000ad01";
const userId = "00000000-0000-0000-0000-00000000ad99";
const runId = "00000000-0000-0000-0000-00000000adbb";
const brandId = "00000000-0000-0000-0000-0000000adb01";

const COLD = "sales-cold-email-outreach";
const FEEDBACK = "feedback-request-cold-email-outreach";
const OFFER_A = "aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa";
const OFFER_B = "bbbbbbbb-4444-4444-8444-bbbbbbbbbbbb";

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

/** Seed a ceiling directly, the way a pre-0037 write left it: unscoped. */
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
    offers: (res.body.offers as OfferRow[]).map(
      (o) =>
        [o.funnelKey, o.featureSlug, o.offerId, o.dailyBudgetCents] as const
    ),
  };
}

describe("a named offer adopts its campaign's unscoped ceiling", () => {
  const authHeaders = getAuthHeaders(orgId, userId, runId);

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("replaces the unscoped ceiling instead of storing a second row", async () => {
    await seedCeiling("visit_form", COLD, null, "4000.0000000000");

    const res = await request(app)
      .patch(funnelOnePath("visit_form"))
      .set(authHeaders)
      .send({ featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 4000 });

    expect(res.status).toBe(200);

    const after = await read();
    expect(after.offers).toEqual([
      ["visit_form", COLD, OFFER_A, "4000.0000000000"],
    ]);
    expect(after.funnels).toEqual([["visit_form", "4000.0000000000"]]);
    expect(after.brandTotal).toBe("4000.0000000000");
  });

  it("reproduces the live brand: two channels, one of them offer-scoped", async () => {
    // $40 sales + $10 feedback, funded before offers existed; the settings page
    // then re-states the $40 under the offer its campaign belongs to.
    await seedCeiling("reply_meeting", COLD, null, "4000.0000000000");
    await seedCeiling("reply_meeting", FEEDBACK, null, "1000.0000000000");

    await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 4000 })
      .expect(200);

    const after = await read();
    expect(after.offers).toEqual([
      ["reply_meeting", FEEDBACK, null, "1000.0000000000"],
      ["reply_meeting", COLD, OFFER_A, "4000.0000000000"],
    ]);
    // $50/day — what was funded — not the $90/day the sum of both rows gave.
    expect(after.brandTotal).toBe("5000.0000000000");

    const brandRead = await request(app)
      .get(brandReadPath)
      .set(internalHeaders)
      .expect(200);
    expect(brandRead.body.dailyBudgetCents).toBe("5000.0000000000");
  });

  it("writes a new amount, not the amount the unscoped row carried", async () => {
    await seedCeiling("visit_form", COLD, null, "4000.0000000000");

    await request(app)
      .patch(funnelOnePath("visit_form"))
      .set(authHeaders)
      .send({ featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 2500 })
      .expect(200);

    const after = await read();
    expect(after.offers).toEqual([
      ["visit_form", COLD, OFFER_A, "2500.0000000000"],
    ]);
    expect(after.brandTotal).toBe("2500.0000000000");
  });

  it("still updates that offer's own ceiling in place", async () => {
    await seedCeiling("visit_form", COLD, OFFER_A, "4000.0000000000");

    await request(app)
      .patch(funnelOnePath("visit_form"))
      .set(authHeaders)
      .send({ featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 1500 })
      .expect(200);

    const after = await read();
    expect(after.offers).toEqual([
      ["visit_form", COLD, OFFER_A, "1500.0000000000"],
    ]);
    expect(after.brandTotal).toBe("1500.0000000000");
  });

  it("gives a second named offer its own row beside the first", async () => {
    await seedCeiling("visit_form", COLD, OFFER_A, "4000.0000000000");

    await request(app)
      .patch(funnelOnePath("visit_form"))
      .set(authHeaders)
      .send({ featureSlug: COLD, offerId: OFFER_B, dailyBudgetCents: 1000 })
      .expect(200);

    const after = await read();
    expect(after.offers).toEqual([
      ["visit_form", COLD, OFFER_A, "4000.0000000000"],
      ["visit_form", COLD, OFFER_B, "1000.0000000000"],
    ]);
    expect(after.funnels).toEqual([["visit_form", "5000.0000000000"]]);
    expect(after.brandTotal).toBe("5000.0000000000");
  });

  it("leaves an unscoped ceiling alone when the pair is already split", async () => {
    // No unambiguous owner for the unscoped remainder here, so nothing is
    // attributed — the write only touches the offer it names.
    await seedCeiling("visit_form", COLD, null, "4000.0000000000");
    await seedCeiling("visit_form", COLD, OFFER_A, "1000.0000000000");

    await request(app)
      .patch(funnelOnePath("visit_form"))
      .set(authHeaders)
      .send({ featureSlug: COLD, offerId: OFFER_B, dailyBudgetCents: 500 })
      .expect(200);

    const after = await read();
    expect(after.offers).toEqual([
      ["visit_form", COLD, null, "4000.0000000000"],
      ["visit_form", COLD, OFFER_A, "1000.0000000000"],
      ["visit_form", COLD, OFFER_B, "500.0000000000"],
    ]);
  });

  it("does not adopt across channels", async () => {
    await seedCeiling("visit_form", COLD, null, "4000.0000000000");

    await request(app)
      .patch(funnelOnePath("visit_form"))
      .set(authHeaders)
      .send({ featureSlug: FEEDBACK, offerId: OFFER_A, dailyBudgetCents: 1000 })
      .expect(200);

    const after = await read();
    expect(after.offers).toEqual([
      ["visit_form", FEEDBACK, OFFER_A, "1000.0000000000"],
      ["visit_form", COLD, null, "4000.0000000000"],
    ]);
    expect(after.brandTotal).toBe("5000.0000000000");
  });

  // --- The offer-LESS write is untouched ---

  it("keeps the offer-less write updating the unscoped ceiling in place", async () => {
    await seedCeiling("visit_form", COLD, null, "4000.0000000000");

    await request(app)
      .patch(funnelOnePath("visit_form"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 2000 })
      .expect(200);

    const after = await read();
    expect(after.offers).toEqual([
      ["visit_form", COLD, null, "2000.0000000000"],
    ]);
    expect(after.brandTotal).toBe("2000.0000000000");
  });

  // --- The whole-set write already replaced everything absent from the body ---

  it("keeps one row when the whole set names the offer", async () => {
    await seedCeiling("visit_form", COLD, null, "4000.0000000000");

    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          {
            funnelKey: "visit_form",
            featureSlug: COLD,
            offerId: OFFER_A,
            dailyBudgetCents: 4000,
          },
        ],
      })
      .expect(200);

    const after = await read();
    expect(after.offers).toEqual([
      ["visit_form", COLD, OFFER_A, "4000.0000000000"],
    ]);
    expect(after.brandTotal).toBe("4000.0000000000");
  });

  // --- The minimum is judged on the ADOPTED outcome, not on both rows ---

  it("judges the funnel minimum on what the pair will hold after the write", async () => {
    // A grandfathered $20/day ceiling on a $24/day funnel: it may be kept or
    // raised, never lowered. Counting the adopted row as well would read this
    // $5 write as a $25 total and wave it through.
    await seedCeiling("reply_meeting", COLD, null, "2000.0000000000");

    const res = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 500 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("$20/day");

    const after = await read();
    expect(after.offers).toEqual([
      ["reply_meeting", COLD, null, "2000.0000000000"],
    ]);
  });

  it("lets a grandfathered ceiling be re-stated under its offer", async () => {
    await seedCeiling("reply_meeting", COLD, null, "2000.0000000000");

    await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 2000 })
      .expect(200);

    const after = await read();
    expect(after.offers).toEqual([
      ["reply_meeting", COLD, OFFER_A, "2000.0000000000"],
    ]);
    expect(after.brandTotal).toBe("2000.0000000000");
  });
});
