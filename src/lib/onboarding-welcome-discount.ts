import { and, eq, inArray, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  localPromoCodes,
  localPromos,
  TRIAL_SEED_CODE,
  WELCOME_PROMO_CODE,
} from "../db/schema.js";

/**
 * The welcome gift shown as a real discount on the ONBOARDING checkout.
 *
 * A new customer picks a daily budget and pays for its first day. They already
 * hold the welcome gift (granted at signup), so they are charged `budget − gift`
 * and end up with exactly `budget` to spend. Until this existed the dashboard did
 * that subtraction itself and sent the net amount, so the Stripe page showed one
 * unexplained line ("$38.00" for a $68 budget) and a real signup abandoned on it.
 *
 * Now the caller sends the FULL budget with `apply_welcome_gift: true`, and billing
 * expresses the gift to the acquirer as a standard coupon: the line item at the
 * budget, the gift as a discount line, the total they pay.
 *
 * THE DEDUCTION IS ONE DECISION, OWNED BY EXACTLY ONE LAYER — whoever sets the flag
 * hands it to billing. A caller that does NOT set the flag gets the byte-identical
 * checkout it always got (no `discounts`), which is what keeps a dashboard build
 * that still subtracts the gift itself from ever being discounted twice.
 *
 * No credit is created by the discount: credit lands from what the acquirer actually
 * receives (`budget − gift`), and the gift itself was already granted at signup.
 */

/** Refusals the caller can branch on. Each is a state where no discount can be honest. */
export type WelcomeDiscountRefusalCode =
  | "welcome_discount_not_first_payment"
  | "welcome_gift_covers_budget";

export class WelcomeDiscountRefusedError extends Error {
  constructor(
    readonly code: WelcomeDiscountRefusalCode,
    message: string,
    readonly giftCents: number
  ) {
    super(message);
  }
}

/**
 * Stripe coupon id for a gift of `cents`, in USD. Derived from the amount, so the
 * coupon's value and the credit it stands for cannot drift apart: a re-priced
 * welcome offer points at a different coupon, and a coupon that does not exist makes
 * the acquirer refuse the checkout (loud) instead of discounting the wrong amount.
 * Each id must be minted once per Stripe account (amount_off = cents, currency usd,
 * duration once).
 */
export function welcomeGiftCouponId(cents: number): string {
  return `distribute_welcome_gift_${cents}_usd`;
}

/**
 * The free credit this org received at signup: its welcome row plus any trial seed
 * (a seeded org gets the welcome REMAINDER at signup, so the two together are the
 * welcome amount). Referral rewards, the org-creation bonus and staff grants are not
 * the welcome gift and never come off an onboarding charge.
 */
export async function sumSignupGiftCents(orgId: string): Promise<number> {
  const [row] = await db
    .select({
      total: rawSql<string>`COALESCE(SUM(${localPromos.amountCents}), 0)::text`,
    })
    .from(localPromos)
    .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
    .where(
      and(
        eq(localPromos.orgId, orgId),
        inArray(localPromoCodes.code, [WELCOME_PROMO_CODE, TRIAL_SEED_CODE])
      )
    );
  const total = Number(row?.total ?? "0");
  // A coupon is whole cents. A fractional gift would mean a coupon that cannot
  // equal the credit it stands for — refuse rather than round money.
  if (!Number.isInteger(total)) {
    throw new Error(`org ${orgId} signup gift is not whole cents: ${row?.total}`);
  }
  return total;
}

export interface OnboardingWelcomeDiscount {
  /** What comes off the budget. 0 = this org holds no welcome gift (e.g. its person's welcome lives on another org). */
  giftCents: number;
  /** The coupon to apply; null when giftCents is 0. */
  couponId: string | null;
  /** What the buyer is asked to pay. */
  amountDueCents: number;
}

/**
 * Decide the discount for an opted-in onboarding checkout. Throws
 * `WelcomeDiscountRefusedError` when no honest discount exists:
 *
 * - the org has already paid us → this is not its first checkout, and a gift
 *   granted once must not come off every later top-up;
 * - the gift covers the whole budget → nothing to charge; the caller opens the
 *   no-charge setup-mode card capture instead (a $0 payment is not an order either
 *   acquirer can take).
 */
export async function decideOnboardingWelcomeDiscount(params: {
  orgId: string;
  budgetCents: number;
  paidTopupsCents: string;
}): Promise<OnboardingWelcomeDiscount> {
  const giftCents = await sumSignupGiftCents(params.orgId);
  if (Number(params.paidTopupsCents) > 0) {
    throw new WelcomeDiscountRefusedError(
      "welcome_discount_not_first_payment",
      "The welcome gift only comes off the first checkout; this org has already paid",
      giftCents
    );
  }
  if (giftCents === 0) {
    return { giftCents: 0, couponId: null, amountDueCents: params.budgetCents };
  }
  if (giftCents >= params.budgetCents) {
    throw new WelcomeDiscountRefusedError(
      "welcome_gift_covers_budget",
      "The welcome gift covers the whole budget; open a setup-mode checkout (no charge) instead",
      giftCents
    );
  }
  return {
    giftCents,
    couponId: welcomeGiftCouponId(giftCents),
    amountDueCents: params.budgetCents - giftCents,
  };
}
