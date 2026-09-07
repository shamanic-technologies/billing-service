/**
 * The flat $30 welcome offer (migration 0040).
 *
 * The offer stopped being a MATCH. A new signup receives $30 of free credit the
 * moment its account exists, unconditionally, with no payment threshold and no
 * second instalment. The gift is delivered through TWO sides of one $30:
 *
 *   credit granted = $30, always, at signup
 *   cash charged   = max($0, daily_budget - $30) at the onboarding checkout
 *
 * So a $30/day signup pays nothing and starts with $30 of balance; a $50/day signup
 * pays $20 and starts with $50. Both received exactly $30. The invariant these cases
 * exist to pin is that it is never $60 and never $0.
 *
 * Own file, not a `describe` appended to an existing suite: those close the shared
 * postgres.js connection in `afterAll`, which would take this block down with
 * `write CONNECTION_ENDED` (see CLAUDE.md).
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
import { db } from "../../src/db/index.js";
import {
  billingAccounts,
  freeCreditPromises,
  localPromoCodes,
  localPromos,
  CURRENT_FREE_CREDIT_ENTITLEMENT_CENTS,
  CURRENT_FREE_CREDIT_PAID_TRIGGER_CENTS,
  CURRENT_REFERRAL_PROMISE_AMOUNT_CENTS,
  WELCOME_COMPLETION_CODE,
  WELCOME_PROMO_CODE,
} from "../../src/db/schema.js";
import {
  decideCheckoutWelcomeOffer,
  settleWelcomeCompletion,
} from "../../src/lib/welcome-completion.js";
import { claimReferral } from "../../src/lib/free-credit-promises.js";
import { settleFreeCreditPromises } from "../../src/lib/free-credit-settlement.js";

const FLAT_GIFT_CENTS = 3000;
const COUPON_ID = "coupon_welcome_30";

const orgId = "00000000-0000-0000-0000-0000000005a1";
const otherOrgId = "00000000-0000-0000-0000-0000000005a2";
const userId = "00000000-0000-0000-0000-0000000005a3";

const NEVER_PRE_LAUNCH = () => Promise.resolve("0.0000000000");
const cents = (n: number) => `${n}.0000000000`;

/** A real signup: findOrCreateAccount inserts org_id only, so the DEFAULT decides. */
async function insertSignupAccount(id: string) {
  await db.insert(billingAccounts).values({ orgId: id });
  await db
    .update(billingAccounts)
    .set({ welcomeCompletionEligible: true })
    .where(eq(billingAccounts.orgId, id));
}

/** What the dashboard's boot-time re-price makes the signup grant worth. */
async function repriceWelcomeCodeToFlatGift() {
  await db
    .update(localPromoCodes)
    .set({ amountCents: FLAT_GIFT_CENTS })
    .where(eq(localPromoCodes.code, WELCOME_PROMO_CODE));
}

/** Signup as it really happens: account created, then the $30 welcome row granted. */
async function signupWithFlatGift(id: string) {
  await insertSignupAccount(id);
  await repriceWelcomeCodeToFlatGift();
  await insertTestPromoGrant({
    orgId: id,
    userId,
    amountCents: FLAT_GIFT_CENTS,
    promoCode: WELCOME_PROMO_CODE,
  });
}

async function giftedTotalCents(id: string): Promise<number> {
  const rows = await db
    .select({ amountCents: localPromos.amountCents })
    .from(localPromos)
    .where(eq(localPromos.orgId, id));
  return rows.reduce((sum, r) => sum + Number(r.amountCents), 0);
}

async function completionRowCount(id: string): Promise<number> {
  const rows = await db
    .select({ id: localPromos.id })
    .from(localPromos)
    .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
    .where(eq(localPromoCodes.code, WELCOME_COMPLETION_CODE));
  return rows.filter(Boolean).length;
}

describe("flat $30 welcome offer, granted in full at signup", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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
    vi.unstubAllEnvs();
    await cleanTestData();
    await closeDb();
  });

  // --- AC: a newly created account carries a $30 entitlement and a $30 trigger ---

  it("a newly created account carries $30 / $30, from the column DEFAULT", async () => {
    await db.insert(billingAccounts).values({ orgId });

    const [row] = await db
      .select({
        entitlementCents: billingAccounts.freeCreditEntitlementCents,
        paidTriggerCents: billingAccounts.freeCreditPaidTriggerCents,
      })
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId));

    expect(row).toEqual({ entitlementCents: 3000, paidTriggerCents: 3000 });
    expect(CURRENT_FREE_CREDIT_ENTITLEMENT_CENTS).toBe(3000);
    expect(CURRENT_FREE_CREDIT_PAID_TRIGGER_CENTS).toBe(3000);
  });

  // --- AC: welcome + completion totals EXACTLY $30, never more ---

  it("the completion is a clean no-op at a zero remainder, and inserts nothing", async () => {
    await signupWithFlatGift(orgId);

    const outcome = await settleWelcomeCompletion(
      orgId,
      cents(FLAT_GIFT_CENTS),
      NEVER_PRE_LAUNCH
    );

    expect(outcome.granted).toBe(false);
    expect(outcome.reason).toBe("entitlement_already_full");
    expect(outcome.amountCents).toBe("0.0000000000");
    // The whole point: no $0 row, no throw, nothing written.
    expect(await completionRowCount(orgId)).toBe(0);
    expect(await giftedTotalCents(orgId)).toBe(FLAT_GIFT_CENTS);
  });

  it("stays exactly $30 whatever the org pays, and at any number of settles", async () => {
    await signupWithFlatGift(orgId);

    for (const paid of [0, 3000, 5000, 100000]) {
      const outcome = await settleWelcomeCompletion(
        orgId,
        cents(paid),
        NEVER_PRE_LAUNCH
      );
      expect(outcome.granted).toBe(false);
      expect(await giftedTotalCents(orgId)).toBe(FLAT_GIFT_CENTS);
    }
    expect(await completionRowCount(orgId)).toBe(0);
  });

  it("is never $0 either: an account whose welcome row is missing still earns its $30", async () => {
    // Belt and braces on the OTHER side of the invariant. If the signup grant never
    // landed, the completion machinery still owes the org its full entitlement — so
    // the flat offer cannot silently become nothing.
    await insertSignupAccount(orgId);

    const outcome = await settleWelcomeCompletion(
      orgId,
      cents(FLAT_GIFT_CENTS),
      NEVER_PRE_LAUNCH
    );

    expect(outcome.granted).toBe(true);
    expect(outcome.amountCents).toBe(cents(FLAT_GIFT_CENTS));
    expect(await giftedTotalCents(orgId)).toBe(FLAT_GIFT_CENTS);
  });

  // --- AC: an existing $400 or $25 account is untouched ---

  it("an existing $400 account keeps its own offer and its own two-stage behaviour", async () => {
    await insertTestAccount({
      orgId: otherOrgId,
      welcomeCompletionEligible: true,
      freeCreditEntitlementCents: 40000,
      freeCreditPaidTriggerCents: 40000,
    });
    await insertTestPromoGrant({
      orgId: otherOrgId,
      userId,
      amountCents: 500,
      promoCode: WELCOME_PROMO_CODE,
    });

    // The new $30 trigger must not reach it: $30 of payments earns nothing here.
    const below = await settleWelcomeCompletion(
      otherOrgId,
      cents(3000),
      NEVER_PRE_LAUNCH
    );
    expect(below.granted).toBe(false);
    expect(below.reason).toBe("payments_below_trigger");

    const earned = await settleWelcomeCompletion(
      otherOrgId,
      cents(40000),
      NEVER_PRE_LAUNCH
    );
    expect(earned.granted).toBe(true);
    expect(earned.amountCents).toBe(cents(39500));
    expect(await giftedTotalCents(otherOrgId)).toBe(40000);
  });

  it("an existing $25 account keeps its own offer and is not re-priced to $30", async () => {
    await insertTestAccount({ orgId: otherOrgId, welcomeCompletionEligible: true });
    await insertTestPromoGrant({
      orgId: otherOrgId,
      userId,
      amountCents: 500,
      promoCode: WELCOME_PROMO_CODE,
    });

    const [row] = await db
      .select({
        entitlementCents: billingAccounts.freeCreditEntitlementCents,
        paidTriggerCents: billingAccounts.freeCreditPaidTriggerCents,
      })
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, otherOrgId));
    expect(row).toEqual({ entitlementCents: 2500, paidTriggerCents: 2500 });

    const earned = await settleWelcomeCompletion(
      otherOrgId,
      cents(2500),
      NEVER_PRE_LAUNCH
    );
    expect(earned.granted).toBe(true);
    // $20, i.e. its OWN $25 entitlement minus its $5 welcome — not $25, not $30.
    expect(earned.amountCents).toBe(cents(2000));
    expect(await giftedTotalCents(otherOrgId)).toBe(2500);
  });

  // --- AC: the buyer SEES the $30 come off a payment-mode checkout ---

  it("shows the discount on the checkout page for an org that still has its $30", async () => {
    await signupWithFlatGift(orgId);
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    vi.stubEnv("WELCOME_DISCOUNT_COUPON_ID", COUPON_ID);
    vi.stubEnv("WELCOME_DISCOUNT_COUPON_AMOUNT_CENTS", String(FLAT_GIFT_CENTS));

    // A $50/day signup: the dashboard charges the full budget and the $30 comes off
    // in front of the buyer, so they pay $20 and hold $50.
    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        success_url: "https://example.com/s",
        cancel_url: "https://example.com/c",
        topup_amount_cents: 5000,
      });
    expect(res.status).toBe(200);

    const body = ssMocks.createCheckoutSession.mock.calls[0][1];
    expect(body.discounts).toEqual([{ coupon: COUPON_ID }]);
    // Mutually exclusive with the notice: nothing is "still coming".
    expect(body).not.toHaveProperty("custom_text");
    // The charge is the full budget; Stripe applies the coupon to it.
    expect(body.line_items[0].price_data.unit_amount).toBe(5000);
  });

  it("does not discount a later top-up: the gift lands once, on the first checkout", async () => {
    await signupWithFlatGift(orgId);
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(cents(5000));
    vi.stubEnv("WELCOME_DISCOUNT_COUPON_ID", COUPON_ID);
    vi.stubEnv("WELCOME_DISCOUNT_COUPON_AMOUNT_CENTS", String(FLAT_GIFT_CENTS));

    const offer = await decideCheckoutWelcomeOffer(orgId, cents(5000));
    expect(offer).toEqual({ couponId: null, noticeMessage: null });
  });

  it("does not hand a $30 coupon to a grandfathered $25 org", async () => {
    await insertTestAccount({ orgId: otherOrgId, welcomeCompletionEligible: true });
    await insertTestPromoGrant({
      orgId: otherOrgId,
      userId,
      amountCents: 2500,
      promoCode: WELCOME_PROMO_CODE,
    });
    vi.stubEnv("WELCOME_DISCOUNT_COUPON_ID", COUPON_ID);
    vi.stubEnv("WELCOME_DISCOUNT_COUPON_AMOUNT_CENTS", String(FLAT_GIFT_CENTS));

    // Fully gifted and never paid, so only the amount check stands between this org
    // and a coupon worth $5 more than its entitlement.
    const offer = await decideCheckoutWelcomeOffer(otherOrgId, "0.0000000000");
    expect(offer).toEqual({ couponId: null, noticeMessage: null });
  });

  it("applies no discount when no coupon is configured, and still grants the credit", async () => {
    await signupWithFlatGift(orgId);
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        success_url: "https://example.com/s",
        cancel_url: "https://example.com/c",
        topup_amount_cents: 5000,
      });
    expect(res.status).toBe(200);

    const body = ssMocks.createCheckoutSession.mock.calls[0][1];
    expect(body).not.toHaveProperty("discounts");
    expect(body).not.toHaveProperty("custom_text");
    // The credit is in the ledger either way — the discount is only its cash side.
    expect(await giftedTotalCents(orgId)).toBe(FLAT_GIFT_CENTS);
  });

  it("applies no discount when the declared coupon amount is unparseable", async () => {
    await signupWithFlatGift(orgId);
    vi.stubEnv("WELCOME_DISCOUNT_COUPON_ID", COUPON_ID);
    vi.stubEnv("WELCOME_DISCOUNT_COUPON_AMOUNT_CENTS", "thirty dollars");

    expect(await decideCheckoutWelcomeOffer(orgId, "0.0000000000")).toEqual({
      couponId: null,
      noticeMessage: null,
    });
  });

  // --- The referral ladder stacks on the new bar with no special-casing ---

  it("a referred signup's $500 promise sits at $30 + $500, straight from the ladder", async () => {
    await insertSignupAccount(otherOrgId); // the inviter
    await insertSignupAccount(orgId); // the invitee
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");

    // Materialise the invitee's welcome promise at its own $30 bar.
    await settleFreeCreditPromises(orgId, "0.0000000000");
    await claimReferral(orgId, otherOrgId);

    const rows = await db
      .select({
        amountCents: freeCreditPromises.amountCents,
        paidTriggerCents: freeCreditPromises.paidTriggerCents,
      })
      .from(freeCreditPromises)
      .where(eq(freeCreditPromises.orgId, orgId));

    expect(rows).toEqual(
      expect.arrayContaining([
        { amountCents: 3000, paidTriggerCents: 3000 },
        {
          amountCents: CURRENT_REFERRAL_PROMISE_AMOUNT_CENTS,
          paidTriggerCents: 3000 + CURRENT_REFERRAL_PROMISE_AMOUNT_CENTS,
        },
      ])
    );
  });
});
