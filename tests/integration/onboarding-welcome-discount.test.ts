/**
 * The welcome gift shown as a real Stripe discount on the onboarding checkout.
 *
 * The caller opts in with `apply_welcome_gift: true` and sends the FULL budget;
 * billing takes the gift the org holds off it as a coupon. Without the flag the
 * checkout is byte-identical to before (the dashboard that still subtracts the gift
 * itself), which is what makes a double deduction impossible on any path.
 *
 * Own file: other suites close the shared connection in `afterAll` (see CLAUDE.md).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestPromoGrant, useLegacyOfferDefaults, restoreCurrentOfferDefaults } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import * as runsClient from "../../src/lib/runs-client.js";
import { db } from "../../src/db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  TRIAL_SEED_CODE,
  WELCOME_PROMO_CODE,
} from "../../src/db/schema.js";
import { welcomeGiftCouponId } from "../../src/lib/onboarding-welcome-discount.js";

const GIFT = 3000;
const BUDGET = 6800;
const orgId = "00000000-0000-0000-0000-0000000007a1";
const userId = "00000000-0000-0000-0000-0000000007a3";
const cents = (n: number) => `${n}.0000000000`;

async function signupWithGift(amounts: Array<[string, number]> = [[WELCOME_PROMO_CODE, GIFT]]) {
  await db.insert(billingAccounts).values({ orgId });
  await db
    .update(localPromoCodes)
    .set({ amountCents: GIFT })
    .where(eq(localPromoCodes.code, WELCOME_PROMO_CODE));
  for (const [code, amountCents] of amounts) {
    await insertTestPromoGrant({ orgId, userId, amountCents, promoCode: code });
  }
}

/** What Stripe answers for a $68 line with a $30 coupon applied. */
function stripeSession(subtotal: number, discount: number) {
  return {
    session_id: "cs_test_welcome",
    url: "https://checkout.stripe.com/c/pay/cs_test_welcome",
    amount_subtotal: subtotal,
    amount_total: subtotal - discount,
    total_details: { amount_discount: discount },
  };
}

const hosted = (extra: Record<string, unknown>) => ({
  success_url: "https://example.com/s",
  cancel_url: "https://example.com/c",
  ...extra,
});

describe("onboarding checkout: the welcome gift as a Stripe discount", () => {
  const app = createTestApp();
  let ss: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ss = setupStripeMocks();
    await cleanTestData();
    ss.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
  });

  // Written against what a freshly created account got before migration 0066
  // (a legacy account): see useLegacyOfferDefaults.
  beforeAll(async () => {
    await useLegacyOfferDefaults();
  });

  afterAll(async () => {
    await restoreCurrentOfferDefaults();
    await cleanTestData();
    await closeDb();
  });

  it("opted in: $68 line, $30 coupon, $38 due", async () => {
    await signupWithGift();
    ss.createCheckoutSession.mockResolvedValue(stripeSession(BUDGET, GIFT));

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send(hosted({ topup_amount_cents: BUDGET, apply_welcome_gift: true }));

    expect(res.status).toBe(200);
    const body = ss.createCheckoutSession.mock.calls[0][1];
    expect(body.line_items[0].price_data.unit_amount).toBe(BUDGET);
    expect(body.discounts).toEqual([{ coupon: "distribute_welcome_gift_3000_usd" }]);
    expect(res.body).toMatchObject({
      url: "https://checkout.stripe.com/c/pay/cs_test_welcome",
      session_id: "cs_test_welcome",
      welcome_discount_cents: GIFT,
      amount_due_cents: BUDGET - GIFT,
    });
  });

  it("NOT opted in: exactly today's checkout, the caller's net amount, no discount", async () => {
    await signupWithGift();
    ss.createCheckoutSession.mockResolvedValue({ session_id: "cs_x", url: "https://x" });

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send(hosted({ topup_amount_cents: BUDGET - GIFT }));

    expect(res.status).toBe(200);
    const body = ss.createCheckoutSession.mock.calls[0][1];
    expect(body).not.toHaveProperty("discounts");
    expect(body.line_items[0].price_data.unit_amount).toBe(BUDGET - GIFT);
    expect(res.body).toEqual({ url: "https://x", session_id: "cs_x" });
  });

  it("apply_welcome_gift=false is the same as absent", async () => {
    await signupWithGift();
    ss.createCheckoutSession.mockResolvedValue({ session_id: "cs_x", url: "https://x" });
    await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send(hosted({ topup_amount_cents: 3800, apply_welcome_gift: false }));
    expect(ss.createCheckoutSession.mock.calls[0][1]).not.toHaveProperty("discounts");
  });

  it("a trial-seeded org's gift is seed + welcome remainder", async () => {
    await signupWithGift([
      [TRIAL_SEED_CODE, 500],
      [WELCOME_PROMO_CODE, 2500],
    ]);
    ss.createCheckoutSession.mockResolvedValue(stripeSession(BUDGET, GIFT));

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send(hosted({ topup_amount_cents: BUDGET, apply_welcome_gift: true }));

    expect(res.status).toBe(200);
    expect(ss.createCheckoutSession.mock.calls[0][1].discounts).toEqual([
      { coupon: welcomeGiftCouponId(3000) },
    ]);
  });

  it("refuses on an org that has already paid (the gift comes off the first checkout only)", async () => {
    await signupWithGift();
    ss.sumSucceededTopupsForOrg.mockResolvedValue(cents(3800));

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send(hosted({ topup_amount_cents: BUDGET, apply_welcome_gift: true }));

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "welcome_discount_not_first_payment", welcome_gift_cents: GIFT });
    expect(ss.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("refuses when the gift covers the whole budget (use setup mode)", async () => {
    await signupWithGift();

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send(hosted({ topup_amount_cents: 3000, apply_welcome_gift: true }));

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "welcome_gift_covers_budget", welcome_gift_cents: GIFT });
    expect(ss.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("an org holding no welcome gift is charged the full budget, no coupon", async () => {
    await db.insert(billingAccounts).values({ orgId });
    ss.createCheckoutSession.mockResolvedValue(stripeSession(BUDGET, 0));

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send(hosted({ topup_amount_cents: BUDGET, apply_welcome_gift: true }));

    expect(res.status).toBe(200);
    expect(ss.createCheckoutSession.mock.calls[0][1]).not.toHaveProperty("discounts");
    expect(res.body).toMatchObject({ welcome_discount_cents: 0, amount_due_cents: BUDGET });
  });

  it("fails loud when the acquirer did not charge budget − gift (never the full budget)", async () => {
    await signupWithGift();
    // Coupon ignored: Stripe would charge the full $68.
    ss.createCheckoutSession.mockResolvedValue(stripeSession(BUDGET, 0));

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send(hosted({ topup_amount_cents: BUDGET, apply_welcome_gift: true }));

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("welcome_discount_not_applied");
    expect(res.body).not.toHaveProperty("url");
  });

  it("second acquirer: the neutral checkout's amount must be budget − gift", async () => {
    await signupWithGift();
    ss.createCheckoutSession.mockResolvedValue({
      id: "ord_1",
      presentation: "hosted_redirect",
      url: "https://revolut.example/pay",
      amount: BUDGET - GIFT,
      currency: "USD",
    });

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send(hosted({ topup_amount_cents: BUDGET, apply_welcome_gift: true }));

    expect(res.status).toBe(200);
    expect(ss.createCheckoutSession.mock.calls[0][1].discounts).toEqual([
      { coupon: "distribute_welcome_gift_3000_usd" },
    ]);
    expect(res.body.amount_due_cents).toBe(BUDGET - GIFT);
  });

  it("refuses apply_welcome_gift on a setup-mode checkout", async () => {
    await signupWithGift();
    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send(hosted({ mode: "setup", apply_welcome_gift: true }));
    expect(res.status).toBe(400);
    expect(ss.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("after paying the opted-in $38, spendable balance is the $68 budget", async () => {
    await signupWithGift();
    // Credit lands from what Stripe actually received: $38, never $68.
    ss.sumSucceededTopupsForOrg.mockResolvedValue(cents(BUDGET - GIFT));

    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));

    expect(res.status).toBe(200);
    expect(Number(res.body.balance_cents)).toBe(BUDGET);
    expect(Number(res.body.credited_gifted_cents)).toBe(GIFT);
  });
});
