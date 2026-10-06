/**
 * The free-credit offer is a PER-ACCOUNT property (migration 0032, re-priced by 0040).
 *
 * distribute has re-priced it twice: $25 -> $400 -> a flat $30. Each re-price is for
 * NEW customers only, so THREE cohorts now coexist and every org keeps the offer it
 * signed up under, permanently. These cases pin all three side by side, plus the two
 * properties that make the NEXT re-price free: the amount is written from the column
 * DEFAULT at account creation, and the completion remainder stays derived from what
 * the org was actually gifted.
 *
 * The flat $30 cohort's own behaviour (grant in full at signup, completion a clean
 * no-op, discount on the checkout price) lives in flat-welcome-offer.test.ts.
 *
 * Own file, not a `describe` appended to welcome-completion.test.ts: that suite
 * closes the shared postgres.js connection in `afterAll`, which would take this
 * block down with `write CONNECTION_ENDED` (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertTestAccount,
  insertTestPromoGrant,
} from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import * as runsClient from "../../src/lib/runs-client.js";
import { db, sql } from "../../src/db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  WELCOME_COMPLETION_CODE,
  WELCOME_PROMO_AMOUNT_CENTS,
  CURRENT_FREE_CREDIT_ENTITLEMENT_CENTS,
  CURRENT_FREE_CREDIT_PAID_TRIGGER_CENTS,
  GRANDFATHERED_FREE_CREDIT_ENTITLEMENT_CENTS,
  GRANDFATHERED_FREE_CREDIT_PAID_TRIGGER_CENTS,
} from "../../src/db/schema.js";
import {
  settleWelcomeCompletion,
  welcomeCompletionCheckoutNotice,
} from "../../src/lib/welcome-completion.js";

const COUPON_ID = "coupon_welcome";
const newOrgId = "00000000-0000-0000-0000-0000000004a1";
const oldOrgId = "00000000-0000-0000-0000-0000000004a2";
const userId = "00000000-0000-0000-0000-0000000004a3";

const NEVER_PRE_LAUNCH = () => Promise.resolve("0.0000000000");

/** Cents string in the canonical 10-decimal form the ledger stores. */
const cents = (n: number) => `${n}.0000000000`;

/** The org's stored offer, i.e. what every read resolves against. */
async function storedOffer(orgId: string) {
  const [row] = await db
    .select({
      entitlementCents: billingAccounts.freeCreditEntitlementCents,
      paidTriggerCents: billingAccounts.freeCreditPaidTriggerCents,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId));
  return row;
}

async function completionRows(orgId: string) {
  return db
    .select({ amountCents: localPromos.amountCents })
    .from(localPromos)
    .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
    .where(eq(localPromoCodes.code, WELCOME_COMPLETION_CODE));
}

/**
 * An account created between 0032 and 0040, i.e. the $400 MATCH cohort. Its figures
 * are stated explicitly because they are no longer the column DEFAULT — which is the
 * point: the re-price reached the default and left this row alone.
 */
async function insertLegacyMatchAccount(orgId: string) {
  await db.insert(billingAccounts).values({
    orgId,
    freeCreditEntitlementCents: 40000,
    freeCreditPaidTriggerCents: 40000,
  });
  await db
    .update(billingAccounts)
    .set({ welcomeCompletionEligible: true })
    .where(eq(billingAccounts.orgId, orgId));
}

describe("per-account free-credit offer (flat $30 current, $400 and $25 grandfathered)", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
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

  // --- AC: the amount is decided once, when the account comes into existence ---

  it("a billing account created after this ships resolves to $30 / $30", async () => {
    // Inserted with org_id only — exactly what findOrCreateAccount writes — so the
    // figures come from the column DEFAULT and nothing in code picks them.
    await db.insert(billingAccounts).values({ orgId: newOrgId });

    expect(await storedOffer(newOrgId)).toEqual({
      entitlementCents: 3000,
      paidTriggerCents: 3000,
    });
    expect(CURRENT_FREE_CREDIT_ENTITLEMENT_CENTS).toBe(3000);
    expect(CURRENT_FREE_CREDIT_PAID_TRIGGER_CENTS).toBe(3000);
  });

  it("an account that existed before resolves to $25 / $25", async () => {
    await insertTestAccount({ orgId: oldOrgId });

    expect(await storedOffer(oldOrgId)).toEqual({
      entitlementCents: 2500,
      paidTriggerCents: 2500,
    });
    expect(GRANDFATHERED_FREE_CREDIT_ENTITLEMENT_CENTS).toBe(2500);
    expect(GRANDFATHERED_FREE_CREDIT_PAID_TRIGGER_CENTS).toBe(2500);
  });

  it("re-applying migration 0032 cannot re-price an account created under a later offer", async () => {
    await db.insert(billingAccounts).values({ orgId: newOrgId });

    // The two statements verbatim from 0032. ADD COLUMN IF NOT EXISTS is a no-op on
    // a column that already exists, so the $30 row keeps its value — this is what
    // makes the migration safe to re-run.
    await sql`ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "free_credit_entitlement_cents" integer NOT NULL DEFAULT 2500`;
    await sql`ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "free_credit_paid_trigger_cents" integer NOT NULL DEFAULT 2500`;

    expect(await storedOffer(newOrgId)).toEqual({
      entitlementCents: 3000,
      paidTriggerCents: 3000,
    });
  });

  it("re-applying migration 0040 writes no row, so no account is re-priced", async () => {
    await insertLegacyMatchAccount(newOrgId);
    await insertTestAccount({ orgId: oldOrgId });

    // 0040 verbatim: it moves the DEFAULT and touches nothing.
    await sql`ALTER TABLE "billing_accounts" ALTER COLUMN "free_credit_entitlement_cents" SET DEFAULT 3000`;
    await sql`ALTER TABLE "billing_accounts" ALTER COLUMN "free_credit_paid_trigger_cents" SET DEFAULT 3000`;

    expect(await storedOffer(newOrgId)).toEqual({
      entitlementCents: 40000,
      paidTriggerCents: 40000,
    });
    expect(await storedOffer(oldOrgId)).toEqual({
      entitlementCents: 2500,
      paidTriggerCents: 2500,
    });
  });

  // --- AC: each cohort earns its own remainder at its own trigger ---

  it("$400 cohort: $399 of payments earns nothing; $400 grants the $395 remainder", async () => {
    await insertLegacyMatchAccount(newOrgId);
    await insertTestPromoGrant({
      orgId: newOrgId,
      userId,
      amountCents: 500,
      promoCode: "welcome",
    });

    const below = await settleWelcomeCompletion(
      newOrgId,
      cents(39900),
      NEVER_PRE_LAUNCH
    );
    expect(below.granted).toBe(false);
    expect(below.reason).toBe("payments_below_trigger");

    const earned = await settleWelcomeCompletion(
      newOrgId,
      cents(40000),
      NEVER_PRE_LAUNCH
    );
    expect(earned.granted).toBe(true);
    // DERIVED: $400 entitlement − the $5 welcome row already gifted.
    expect(earned.amountCents).toBe(cents(39500));
    expect(await completionRows(newOrgId)).toHaveLength(1);
  });

  it("grandfathered cohort: $25 of payments still grants exactly $20, not $395", async () => {
    await insertTestAccount({ orgId: oldOrgId, welcomeCompletionEligible: true });
    await insertTestPromoGrant({
      orgId: oldOrgId,
      userId,
      amountCents: 500,
      promoCode: "welcome",
    });

    const earned = await settleWelcomeCompletion(
      oldOrgId,
      cents(2500),
      NEVER_PRE_LAUNCH
    );

    expect(earned.granted).toBe(true);
    expect(earned.amountCents).toBe(cents(2000));
  });

  it("the $5 up-front welcome gift is unchanged for both cohorts", async () => {
    const [welcome] = await db
      .select({ amountCents: localPromoCodes.amountCents })
      .from(localPromoCodes)
      .where(eq(localPromoCodes.code, "welcome"));

    expect(welcome.amountCents).toBe(500);
    expect(WELCOME_PROMO_AMOUNT_CENTS).toBe(500);
  });

  // --- AC: the deploy itself changes nothing for an existing org ---

  it("an existing org already gifted its $25 gains nothing from the re-price", async () => {
    await insertTestAccount({ orgId: oldOrgId, welcomeCompletionEligible: true });
    await insertTestPromoGrant({
      orgId: oldOrgId,
      userId,
      amountCents: 500,
      promoCode: "welcome",
    });
    await insertTestPromoGrant({
      orgId: oldOrgId,
      userId,
      amountCents: 2000,
      promoCode: WELCOME_COMPLETION_CODE,
    });
    // Well past the NEW cohort's $400 trigger, which must not reach this org.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(cents(50000));

    const outcome = await settleWelcomeCompletion(
      oldOrgId,
      cents(50000),
      NEVER_PRE_LAUNCH
    );
    expect(outcome.granted).toBe(false);
    expect(outcome.reason).toBe("entitlement_already_full");

    const res = await request(app)
      .get("/v1/accounts")
      .set(getAuthHeaders(oldOrgId));
    expect(res.status).toBe(200);
    expect(res.body.credited_gifted_cents).toBe(cents(2500));
    expect(await completionRows(oldOrgId)).toHaveLength(1);
  });

  // --- The checkout page, for a cohort that still has a remainder coming ---

  it("$400 cohort: a $500 first checkout gets the notice, NOT a discount", async () => {
    await insertLegacyMatchAccount(newOrgId);
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");

    await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(newOrgId))
      .send({
        success_url: "https://example.com/s",
        cancel_url: "https://example.com/c",
        topup_amount_cents: 50000,
      });

    const body = ssMocks.createCheckoutSession.mock.calls[0][1];
    // This org has NOT been gifted its entitlement yet — the $395 remainder is still
    // earned by paying. Discounting here would hand over credit the ledger does not
    // hold, which is exactly what the discount gate forbids.
    expect(body).not.toHaveProperty("discounts");
    expect(body.custom_text).toEqual({
      submit: {
        message:
          "You get $400 in free credits. $5 now, the rest once your payments reach $400.",
      },
    });
  });

  // An $800 first checkout — the old (entitlement + trigger) floor for this cohort —
  // used to be the ONE amount that carried a discount. The floor is gone and the
  // discount is now gated on the entitlement being ALREADY gifted, which this org's
  // is not: no checkout amount brings it back, and a configured coupon must not
  // either.
  it("$400 cohort: an $800 first checkout carries no discount, at any coupon config", async () => {
    await insertLegacyMatchAccount(newOrgId);
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    vi.stubEnv("WELCOME_DISCOUNT_COUPON_ID", COUPON_ID);
    vi.stubEnv("WELCOME_DISCOUNT_COUPON_AMOUNT_CENTS", "40000");

    await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(newOrgId))
      .send({
        success_url: "https://example.com/s",
        cancel_url: "https://example.com/c",
        topup_amount_cents: 80000,
      });

    const body = ssMocks.createCheckoutSession.mock.calls[0][1];
    expect(body).not.toHaveProperty("discounts");
    expect(body.custom_text.submit.message).toContain("$400 in free credits");
  });

  it("the notice quotes the org's own offer, and the $25 wording is byte-identical to today", () => {
    expect(
      welcomeCompletionCheckoutNotice({
        entitlementCents: GRANDFATHERED_FREE_CREDIT_ENTITLEMENT_CENTS,
        paidTriggerCents: GRANDFATHERED_FREE_CREDIT_PAID_TRIGGER_CENTS,
      })
    ).toBe(
      "You get $25 in free credits. $5 now, the rest once your payments reach $25."
    );
    expect(
      welcomeCompletionCheckoutNotice({
        entitlementCents: 40000,
        paidTriggerCents: 40000,
      })
    ).toBe(
      "You get $400 in free credits. $5 now, the rest once your payments reach $400."
    );
  });

  // --- AC: the grant is still exactly-once and still fails loud ---

  it("stays exactly-once per org under concurrent settles at the $400 figure", async () => {
    await insertLegacyMatchAccount(newOrgId);

    const outcomes = await Promise.all([
      settleWelcomeCompletion(newOrgId, cents(40000), NEVER_PRE_LAUNCH),
      settleWelcomeCompletion(newOrgId, cents(40000), NEVER_PRE_LAUNCH),
      settleWelcomeCompletion(newOrgId, cents(40000), NEVER_PRE_LAUNCH),
    ]);

    expect(outcomes.filter((o) => o.granted)).toHaveLength(1);
    expect(await completionRows(newOrgId)).toHaveLength(1);
  });
});
