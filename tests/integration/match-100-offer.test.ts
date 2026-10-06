/**
 * "We match your first $100" (migration 0066, owner 2026-10-06): every NEW org gets
 * $30 at creation, and $70 more once it has PAID $100. Top-ups are at least $100 and
 * the auto-reload threshold at least $5. Existing (legacy) orgs are unchanged.
 *
 * Own file: other suites close the shared connection in `afterAll` (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount, insertTestPromoGrant } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import * as runsClient from "../../src/lib/runs-client.js";
import { db, sql } from "../../src/db/index.js";
import { readFileSync } from "node:fs";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  ORG_CREATION_BONUS_CODE,
  WELCOME_COMPLETION_CODE,
  WELCOME_PROMO_CODE,
} from "../../src/db/schema.js";
import { resolvePostpaidTier, reloadTierFor } from "../../src/lib/topup-tier.js";

const orgId = "00000000-0000-0000-0000-0000000006a1";
const secondOrgId = "00000000-0000-0000-0000-0000000006a2";
const legacyOrgId = "00000000-0000-0000-0000-0000000006a3";
const person = "11111111-1111-4111-8111-1111111116a1";
const internal = { "X-API-Key": "test-api-key" };
const cents = (n: number) => `${n}.0000000000`;

async function rowsByCode(id: string, code: string) {
  return db
    .select({ amountCents: localPromos.amountCents })
    .from(localPromos)
    .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
    .where(and(eq(localPromos.orgId, id), eq(localPromoCodes.code, code)));
}

describe("We match your first $100", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
    // The live welcome price, so a stray welcome grant would be visible.
    await db
      .update(localPromoCodes)
      .set({ amountCents: 3000 })
      .where(eq(localPromoCodes.code, WELCOME_PROMO_CODE));
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  const account = (id: string, user = person) =>
    request(app).get("/v1/accounts").set(getAuthHeaders(id, user));

  it("a brand-new org holds $30 right after creation, and the read states the offer", async () => {
    const res = await account(orgId);
    expect(res.status).toBe(200);
    expect(res.body.credited_gifted_cents).toBe(cents(3000));
    expect(res.body).toMatchObject({
      free_credit_offer: "match_100",
      free_credit_entitlement_cents: 10000,
      free_credit_received_cents: cents(3000),
      free_credit_pending_cents: cents(7000),
      free_credit_paid_trigger_cents: 10000,
      free_credit_remaining_to_pay_cents: cents(10000),
    });
    expect(await rowsByCode(orgId, ORG_CREATION_BONUS_CODE)).toHaveLength(1);
    expect(await rowsByCode(orgId, WELCOME_PROMO_CODE)).toHaveLength(0);
  });

  it("the creation-bonus call and the first billing touch land ONE $30, in either order", async () => {
    const bonus = await request(app)
      .post(`/internal/accounts/by-org/${orgId}/org-creation-bonus`)
      .set(internal);
    expect(bonus.body.grantedCents).toBe(3000);
    const res = await account(orgId);
    expect(res.body.credited_gifted_cents).toBe(cents(3000));
    const again = await request(app)
      .post(`/internal/accounts/by-org/${orgId}/org-creation-bonus`)
      .set(internal);
    expect(again.body.alreadyGranted).toBe(true);
    expect(await rowsByCode(orgId, ORG_CREATION_BONUS_CODE)).toHaveLength(1);
  });

  it("anonymous onboarding: the trial seed is the $30, and signup adds no welcome", async () => {
    const seed = await request(app)
      .post(`/internal/accounts/by-org/${orgId}/trial-seed`)
      .set(internal);
    expect(seed.status).toBe(200);
    expect(seed.body.seededCents).toBe(3000);
    const signup = await request(app)
      .post(`/internal/accounts/by-org/${orgId}/signup`)
      .set({ ...internal, "x-user-id": person });
    expect(signup.status).toBe(200);
    expect(signup.body.welcomeGrantedCents).toBe(0);
    expect(signup.body.totalFreeCreditCents).toBe(3000);
    const res = await account(orgId);
    expect(res.body.credited_gifted_cents).toBe(cents(3000));
    expect(res.body.free_credit_pending_cents).toBe(cents(7000));
  });

  it("the welcome code cannot be redeemed on top", async () => {
    await account(orgId);
    const res = await request(app)
      .post("/v1/promotion_codes/redeem")
      .set(getAuthHeaders(orgId, person))
      .send({ code: WELCOME_PROMO_CODE });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("welcome_not_offered");
  });

  it("a person's second org gets its own $30 and its own $70 to come", async () => {
    await account(orgId);
    const second = await account(secondOrgId);
    expect(second.body.credited_gifted_cents).toBe(cents(3000));
    expect(second.body.free_credit_pending_cents).toBe(cents(7000));
  });

  it("after $100 paid: +$70 lands once ($100 received in total), retries grant nothing", async () => {
    await account(orgId);
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(cents(9999));
    const below = await account(orgId);
    expect(below.body.credited_gifted_cents).toBe(cents(3000));
    expect(below.body.free_credit_remaining_to_pay_cents).toBe(cents(1));

    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(cents(10000));
    const at = await account(orgId);
    expect(at.body.credited_gifted_cents).toBe(cents(10000));
    expect(at.body.free_credit_received_cents).toBe(cents(10000));
    expect(at.body.free_credit_pending_cents).toBe(cents(0));
    expect(at.body.free_credit_remaining_to_pay_cents).toBe(cents(0));

    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(cents(50000));
    await account(orgId);
    await account(orgId);
    const completions = await rowsByCode(orgId, WELCOME_COMPLETION_CODE);
    expect(completions).toHaveLength(1);
    expect(completions[0].amountCents).toBe(cents(7000));
  });

  it("refuses a $99 top-up with a named code, accepts $100", async () => {
    await account(orgId);
    const low = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId, person))
      .send({ success_url: "https://x/s", cancel_url: "https://x/c", topup_amount_cents: 9900 });
    expect(low.status).toBe(400);
    expect(low.body).toMatchObject({ code: "topup_below_minimum", minimum_cents: 10000 });

    const ok = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId, person))
      .send({ success_url: "https://x/s", cancel_url: "https://x/c", topup_amount_cents: 10000 });
    expect(ok.status).toBe(200);
  });

  it("refuses the welcome coupon at checkout (the $30 is credit, not a discount)", async () => {
    await account(orgId);
    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId, person))
      .send({
        success_url: "https://x/s",
        cancel_url: "https://x/c",
        topup_amount_cents: 10000,
        apply_welcome_gift: true,
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("welcome_discount_not_offered");
  });

  it("refuses a $99 on-demand charge with a named code", async () => {
    await account(orgId);
    const res = await request(app)
      .post(`/internal/accounts/by-org/${orgId}/charge`)
      .set(internal)
      .send({ amountCents: 9900 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "topup_below_minimum", minimum_cents: 10000 });
  });

  it("auto-reload: $99 amount and $4 threshold refused, $100 / $5 armed and served back (prepaid)", async () => {
    await account(orgId);
    await db
      .update(billingAccounts)
      .set({ paymentMode: "prepaid" })
      .where(eq(billingAccounts.orgId, orgId));
    ssMocks.hasAttachedCardPm.mockResolvedValue(true);
    const patch = (amount: number, threshold: number) =>
      request(app)
        .patch("/v1/accounts/auto_topup")
        .set(getAuthHeaders(orgId, person))
        .send({ topup_amount_cents: amount, topup_threshold_cents: threshold });

    const lowAmount = await patch(9900, 500);
    expect(lowAmount.status).toBe(400);
    expect(lowAmount.body).toMatchObject({ code: "topup_below_minimum", minimum_cents: 10000 });

    const lowThreshold = await patch(10000, 400);
    expect(lowThreshold.status).toBe(400);
    expect(lowThreshold.body).toMatchObject({
      code: "topup_threshold_below_minimum",
      minimum_cents: 500,
    });

    const ok = await patch(10000, 500);
    expect(ok.status).toBe(200);
    expect(ok.body.topup_amount_cents).toBe(10000);
    expect(ok.body.topup_threshold_cents).toBe(500);
    expect(ok.body.has_auto_topup).toBe(true);
  });

  it("a prepaid match org reloads its stated amount below its stated threshold; postpaid keeps the ladder line", () => {
    const configured = { amountCents: 15000, thresholdCents: 700 };
    expect(reloadTierFor("0", "prepaid", configured)).toEqual({
      thresholdCents: 700,
      amountCents: 15000,
    });
    expect(
      resolvePostpaidTier({
        topupEnabled: true,
        hasCardPm: true,
        autoReloadSupported: true,
        paidTopupsCents: "0",
        paymentMode: "prepaid",
        configuredReload: configured,
      })
    ).toEqual({ tier: { thresholdCents: 700, amountCents: 15000 }, thresholdCents: "700" });
    expect(reloadTierFor("0", "postpaid", configured)).toEqual({
      thresholdCents: -5000,
      amountCents: 15000,
    });
    // Without a configured reload (every legacy org): byte-identical ladder.
    expect(reloadTierFor("0", "prepaid")).toEqual({ thresholdCents: 0, amountCents: 5000 });
  });

  it("the match ends for accounts created on or after 2026-11-01 00:00 UTC (date-aware DEFAULT)", async () => {
    const rows = (await sql`
      SELECT column_name, column_default FROM information_schema.columns
       WHERE table_name = 'billing_accounts'
         AND column_name IN ('free_credit_entitlement_cents', 'free_credit_paid_trigger_cents')
    `) as unknown as { column_name: string; column_default: string }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const at = async (iso: string) => {
        const expr = row.column_default.replace(/now\(\)/g, `'${iso}'::timestamptz`);
        const [r] = (await sql.unsafe(`SELECT (${expr})::int AS v`)) as unknown as { v: number }[];
        return r.v;
      };
      expect(await at("2026-10-31 23:59:59+00")).toBe(10000);
      expect(await at("2026-11-01 00:00:00+00")).toBe(0);
    }
  });

  it("an org created after the end gets no $30 (no account yet: the clock decides)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T00:00:00.000Z"));
    try {
      const res = await request(app)
        .post(`/internal/accounts/by-org/${orgId}/org-creation-bonus`)
        .set(internal);
      expect(res.status).toBe(200);
      expect(res.body.grantedCents).toBe(0);
      expect(await rowsByCode(orgId, ORG_CREATION_BONUS_CODE)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an account created after the end (entitlement 0) gets neither the $30 nor the +$70", async () => {
    await db.insert(billingAccounts).values({
      orgId,
      freeCreditEntitlementCents: 0,
      freeCreditPaidTriggerCents: 0,
    });
    const seed = await request(app)
      .post(`/internal/accounts/by-org/${orgId}/trial-seed`)
      .set(internal);
    expect(seed.body.seededCents).toBe(0);
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(cents(20000));
    const res = await account(orgId);
    expect(res.body.credited_gifted_cents).toBe(cents(0));
    expect(res.body.free_credit_pending_cents).toBe(cents(0));
    expect(res.body.free_credit_remaining_to_pay_cents).toBe(cents(0));
    expect(await rowsByCode(orgId, WELCOME_COMPLETION_CODE)).toHaveLength(0);
    // The minimums are not part of the promotion: they still apply.
    const low = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId, person))
      .send({ success_url: "https://x/s", cancel_url: "https://x/c", topup_amount_cents: 9900 });
    expect(low.body.code).toBe("topup_below_minimum");
  });

  it("an org created before the end keeps its +$70 when it pays after it", async () => {
    await account(orgId);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-15T00:00:00.000Z"));
    try {
      ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(cents(10000));
      const res = await account(orgId);
      expect(res.body.credited_gifted_cents).toBe(cents(10000));
    } finally {
      vi.useRealTimers();
    }
  });

  it("migration 0066 replayed twice: an existing account stays legacy, a new one is match_100 at $100/$100", async () => {
    await insertTestAccount({ orgId: legacyOrgId, freeCreditEntitlementCents: 3000, freeCreditPaidTriggerCents: 3000 });
    const migration = readFileSync(
      new URL("../../drizzle/0066_match_first_100_offer.sql", import.meta.url),
      "utf8"
    );
    await sql.unsafe(migration);
    await sql.unsafe(migration);
    await db.insert(billingAccounts).values({ orgId });
    const rows = await db.select().from(billingAccounts);
    const byOrg = Object.fromEntries(rows.map((r) => [r.orgId, r]));
    expect(byOrg[legacyOrgId]).toMatchObject({
      freeCreditOffer: "legacy",
      freeCreditEntitlementCents: 3000,
      freeCreditPaidTriggerCents: 3000,
    });
    expect(byOrg[orgId]).toMatchObject({
      freeCreditOffer: "match_100",
      freeCreditEntitlementCents: 10000,
      freeCreditPaidTriggerCents: 10000,
    });
  });

  it("an org created before this ship is unchanged: no minimums, no bonus on touch, ladder reload", async () => {
    await insertTestAccount({ orgId: legacyOrgId, freeCreditEntitlementCents: 3000, freeCreditPaidTriggerCents: 3000 });
    await insertTestPromoGrant({ orgId: legacyOrgId, userId: person, amountCents: 3000, promoCode: WELCOME_PROMO_CODE });
    const res = await account(legacyOrgId);
    expect(res.body.free_credit_offer).toBe("legacy");
    expect(res.body.credited_gifted_cents).toBe(cents(3000));
    expect(res.body.free_credit_pending_cents).toBe(cents(0));
    expect(await rowsByCode(legacyOrgId, ORG_CREATION_BONUS_CODE)).toHaveLength(0);

    const checkout = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(legacyOrgId, person))
      .send({ success_url: "https://x/s", cancel_url: "https://x/c", topup_amount_cents: 2000 });
    expect(checkout.status).toBe(200);

    ssMocks.hasAttachedCardPm.mockResolvedValue(true);
    const patch = await request(app)
      .patch("/v1/accounts/auto_topup")
      .set(getAuthHeaders(legacyOrgId, person))
      .send({ topup_amount_cents: 1234, topup_threshold_cents: 0 });
    expect(patch.status).toBe(200);
    expect(patch.body.topup_amount_cents).toBe(5000);
    expect(patch.body.topup_threshold_cents).toBe(-5000);
  });
});
