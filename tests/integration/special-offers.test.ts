import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks, type StripeServiceMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import {
  freeCreditPromises,
  localPromoCodes,
  localPromos,
  specialOfferPayments,
  SPECIAL_OFFER_CODE,
} from "../../src/db/schema.js";
import { sumEntitlementGrantsForOrg } from "../../src/lib/promos.js";

// SPECIAL-OFFER-BF-1127: a named, dated offer ("Black Friday 2026") apart from the
// standing offers. The first case: an org pays $450 on Black Friday, staff doubles it.
describe("Special offers", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-4000-8000-0000000000a1";
  const orgB = "00000000-0000-4000-8000-0000000000a2";
  const referredOrg = "00000000-0000-4000-8000-0000000000a3";
  const staff = "kevin@distribute.you";
  const BF_PAID_AT = Math.floor(Date.parse("2026-11-27T05:25:00Z") / 1000);
  const api = { "X-API-Key": "test-api-key", "Content-Type": "application/json" };
  let mocks: StripeServiceMocks;

  const bfPayment = {
    id: "pay_bf_450",
    acquirer: "revolut",
    amount: 45000,
    currency: "usd",
    status: "succeeded" as const,
    created: BF_PAID_AT,
    amount_returned: 0,
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    mocks = setupStripeMocks();
    await cleanTestData();
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async (org: string) => ({
      org_id: org,
      spent_cents: "1000.0000000000",
      as_of: "2026-11-27T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "1000.0000000000",
    });
    mocks.sumSucceededTopupsForOrg.mockResolvedValue("45000.0000000000");
    mocks.listOrgPayments.mockImplementation(async (org: string) => (org === orgId ? [bfPayment] : []));
    await insertTestAccount({ orgId });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  async function createOffer(overrides: Record<string, unknown> = {}) {
    return request(app)
      .post("/internal/special-offers")
      .set(api)
      .send({
        slug: "black-friday-2026",
        name: "Black Friday 2026",
        startsAt: "2026-11-27T00:00:00Z",
        endsAt: "2026-11-28T12:00:00Z",
        bonusRatioBps: 10000,
        createdBy: staff,
        ...overrides,
      });
  }

  async function apply(body: Record<string, unknown> = {}, slug = "black-friday-2026") {
    return request(app)
      .post(`/internal/special-offers/${slug}/payments`)
      .set(api)
      .send({ orgId, paymentId: bfPayment.id, appliedBy: staff, ...body });
  }

  async function balanceOf(org: string): Promise<string> {
    const res = await request(app).get(`/internal/accounts/by-org/${org}/balance`).set(api);
    expect(res.status).toBe(200);
    return res.body.balance_cents as string;
  }

  it("creating an offer is idempotent on the slug; other terms are refused", async () => {
    const first = await createOffer();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, alreadyExisted: false });
    expect(first.body.specialOffer).toMatchObject({ slug: "black-friday-2026", name: "Black Friday 2026", bonusRatioBps: 10000 });

    const again = await createOffer();
    expect(again.status).toBe(200);
    expect(again.body.alreadyExisted).toBe(true);
    expect(again.body.specialOffer.id).toBe(first.body.specialOffer.id);

    const other = await createOffer({ bonusRatioBps: 5000 });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe("special_offer_exists_with_other_terms");

    const list = await request(app).get("/internal/special-offers").set(api);
    expect(list.body.specialOffers).toHaveLength(1);
  });

  it("doubles a $450 payment: balance = before + $450, credit tied to the offer and the payment", async () => {
    await createOffer();
    const before = await balanceOf(orgId); // paid 45000 − usage 1000
    expect(before).toBe("44000.0000000000");

    const res = await apply();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      alreadyApplied: false,
      orgId,
      specialOffer: { slug: "black-friday-2026", name: "Black Friday 2026" },
      newBalanceCents: "89000.0000000000",
    });
    expect(res.body.payment).toMatchObject({
      payment_id: "pay_bf_450",
      acquirer: "revolut",
      paid_cents: "45000.0000000000",
      paid_at: "2026-11-27T05:25:00.000Z",
      free_credit_cents: "45000.0000000000",
    });
    expect(await balanceOf(orgId)).toBe("89000.0000000000");

    // The credit is a ledger row under the offer's own key, named after the offer.
    const grants = await request(app).get("/v1/credits/grants").set({ ...api, "x-org-id": orgId });
    const grant = grants.body.grants.find((g: { id: string }) => g.id === res.body.payment.grant_id);
    expect(grant).toMatchObject({
      reason: "special_offer",
      amountCents: "45000.0000000000",
      note: "Black Friday 2026: $450.00 free credit",
      grantedBy: staff,
    });
  });

  it("applying again is a no-op: one grant, one link, same balance", async () => {
    await createOffer();
    const first = await apply();
    const second = await apply();
    expect(second.status).toBe(200);
    expect(second.body.alreadyApplied).toBe(true);
    expect(second.body.payment).toEqual(first.body.payment);
    expect(second.body.newBalanceCents).toBe("89000.0000000000");

    const concurrent = await Promise.all([apply(), apply(), apply()]);
    for (const r of concurrent) expect(r.body.alreadyApplied).toBe(true);

    expect(await db.select().from(specialOfferPayments)).toHaveLength(1);
    expect(await db.select().from(localPromos).where(eq(localPromos.orgId, orgId))).toHaveLength(1);

    // A re-apply asking for another amount is refused, never re-granted.
    const other = await apply({ freeCreditCents: 10000 });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe("already_applied_different_amount");
  });

  it("two first applies racing grant once", async () => {
    await createOffer();
    const results = await Promise.all([apply(), apply(), apply(), apply()]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.alreadyApplied === false)).toHaveLength(1);
    expect(await db.select().from(localPromos).where(eq(localPromos.orgId, orgId))).toHaveLength(1);
  });

  it("the client read returns the offer, what was paid and the free credit, for that org only", async () => {
    await createOffer();
    await apply();

    const mine = await request(app).get("/v1/special-offers").set({ ...api, "x-org-id": orgId });
    expect(mine.status).toBe(200);
    expect(mine.body.org_id).toBe(orgId);
    expect(mine.body.special_offers).toHaveLength(1);
    expect(mine.body.special_offers[0]).toMatchObject({
      slug: "black-friday-2026",
      name: "Black Friday 2026",
      paid_cents: "45000.0000000000",
      free_credit_cents: "45000.0000000000",
    });
    expect(mine.body.special_offers[0].payments).toHaveLength(1);
    expect(mine.body.special_offers[0].payments[0]).toMatchObject({
      payment_id: "pay_bf_450",
      paid_cents: "45000.0000000000",
      free_credit_cents: "45000.0000000000",
    });

    // Another org sees nothing, and its balance did not move.
    const theirs = await request(app).get("/v1/special-offers").set({ ...api, "x-org-id": orgB });
    expect(theirs.status).toBe(200);
    expect(theirs.body.special_offers).toEqual([]);
    expect(await db.select().from(localPromos).where(eq(localPromos.orgId, orgB))).toHaveLength(0);

    const noOrg = await request(app).get("/v1/special-offers").set(api);
    expect(noOrg.status).toBe(400);
  });

  it("a payment of ANOTHER org cannot be applied to this org", async () => {
    await createOffer();
    mocks.listOrgPayments.mockImplementation(async (org: string) => (org === orgB ? [bfPayment] : []));
    const res = await apply();
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("payment_not_found");
    expect(await db.select().from(specialOfferPayments)).toHaveLength(0);
    expect(await db.select().from(localPromos)).toHaveLength(0);
  });

  it("NOT cumulative: referral promises and the welcome entitlement do not move", async () => {
    await createOffer();
    // The org holds a pending $500 referral reward (earned on the REFERRED org's payments).
    const claim = await request(app)
      .post("/internal/referrals/claim")
      .set(api)
      .send({ orgId: referredOrg, referrerOrgId: orgId });
    expect(claim.status).toBe(200);
    const promisesBefore = await db.select().from(freeCreditPromises).where(eq(freeCreditPromises.orgId, orgId));
    const entitlementBefore = await sumEntitlementGrantsForOrg(orgId);
    const readHeaders = {
      ...api,
      "x-org-id": orgId,
      "x-user-id": "00000000-0000-4000-8000-000000000099",
      "x-run-id": "00000000-0000-4000-8000-000000000098",
    };
    const listedBefore = await request(app).get("/v1/free-credit-promises").set(readHeaders);
    expect(listedBefore.status).toBe(200);

    expect((await apply()).status).toBe(200);

    const promisesAfter = await db.select().from(freeCreditPromises).where(eq(freeCreditPromises.orgId, orgId));
    expect(promisesAfter).toEqual(promisesBefore);
    expect(promisesAfter.every((p) => p.grantedAt === null)).toBe(true);
    // The $450 credit is outside the welcome entitlement: a welcome remainder never shrinks.
    expect(await sumEntitlementGrantsForOrg(orgId)).toBe(entitlementBefore);
    const listedAfter = await request(app).get("/v1/free-credit-promises").set(readHeaders);
    expect(listedAfter.body.outstanding_total_cents).toBe(listedBefore.body.outstanding_total_cents);
    expect(listedAfter.body.promises).toEqual(listedBefore.body.promises);
    // Only the special-offer row was written on the org's ledger.
    const rows = await db
      .select({ code: localPromoCodes.code })
      .from(localPromos)
      .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
      .where(eq(localPromos.orgId, orgId));
    expect(rows).toEqual([{ code: SPECIAL_OFFER_CODE }]);
  });

  it("refuses a payment that is not eligible, writing nothing", async () => {
    await createOffer();
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ status: "failed" }, 409, "payment_not_succeeded"],
      [{ currency: "eur" }, 409, "payment_currency_unsupported"],
      [{ amount_returned: 45000 }, 409, "payment_fully_returned"],
      [{ created: Math.floor(Date.parse("2026-11-26T23:59:59Z") / 1000) }, 409, "payment_outside_offer_window"],
      [{ created: Math.floor(Date.parse("2026-11-28T12:00:00Z") / 1000) }, 409, "payment_outside_offer_window"],
    ];
    for (const [patch, status, code] of cases) {
      mocks.listOrgPayments.mockResolvedValue([{ ...bfPayment, ...patch }]);
      const res = await apply();
      expect(res.status, code).toBe(status);
      expect(res.body.code).toBe(code);
    }
    const unknownOffer = await apply({}, "cyber-monday-2026");
    expect(unknownOffer.status).toBe(404);
    expect(unknownOffer.body.code).toBe("special_offer_not_found");

    // stripe-service down, or a row that does not say what was returned: 502, nothing applied.
    mocks.listOrgPayments.mockRejectedValue(new Error("stripe-service 503"));
    expect((await apply()).status).toBe(502);
    const { amount_returned: _dropped, ...withoutReturned } = bfPayment;
    mocks.listOrgPayments.mockResolvedValue([withoutReturned]);
    expect((await apply()).status).toBe(502);

    expect(await db.select().from(specialOfferPayments)).toHaveLength(0);
    expect(await db.select().from(localPromos)).toHaveLength(0);
  });

  it("the ratio applies to what was paid NET of returns; a payment counts under one offer only", async () => {
    await createOffer({ bonusRatioBps: 5000 });
    mocks.listOrgPayments.mockResolvedValue([{ ...bfPayment, amount_returned: 5001 }]);
    const res = await apply();
    expect(res.status).toBe(200);
    expect(res.body.payment.paid_cents).toBe("39999.0000000000");
    expect(res.body.payment.free_credit_cents).toBe("20000.0000000000"); // 19999.5 rounded half up

    await createOffer({ slug: "black-friday-bis", name: "Black Friday bis" });
    const other = await apply({}, "black-friday-bis");
    expect(other.status).toBe(409);
    expect(other.body.code).toBe("payment_under_other_offer");
  });

  it("fails loud when the special_offer ledger key is missing", async () => {
    await createOffer();
    await db.delete(localPromoCodes).where(eq(localPromoCodes.code, SPECIAL_OFFER_CODE));
    const res = await apply();
    expect(res.status).toBe(500);
    expect(await db.select().from(specialOfferPayments)).toHaveLength(0);
  });

  it("org teardown removes the org's special-offer payments, keeps the offer", async () => {
    await createOffer();
    await apply();
    const del = await request(app).delete(`/internal/accounts/by-org/${orgId}`).set(api);
    expect(del.status).toBe(200);
    expect(await db.select().from(specialOfferPayments)).toHaveLength(0);
    const list = await request(app).get("/internal/special-offers").set(api);
    expect(list.body.specialOffers).toHaveLength(1);
  });
});
