/**
 * Welcome-completion gift — the second half of the "$25 in free credits" promise.
 *
 * ## The rule
 *
 * An org receives FREE_CREDIT_ENTITLEMENT_CENTS ($25) in free credits IN TOTAL,
 * welcome gift included. Signup grants only the `welcome` row ($5 today), so the
 * completion is worth the remainder. The remainder is DERIVED from what the org
 * has actually been gifted (SUM(local_promos)), never from a hardcoded $20 — so it
 * stays correct if the welcome amount is re-priced or the org never got one.
 *
 * The completion is EARNED once the org's cumulative SUCCEEDED payments reach
 * FREE_CREDIT_PAID_TRIGGER_CENTS ($25). The trigger is money actually received,
 * NOT usage consumed: the account model is threshold-postpaid (an org can consume
 * on credit before paying anything), and we must not gift credits to someone whose
 * card may still fail.
 *
 * ## Who drives it
 *
 * Server-side only. A browser returning from Stripe is never the authority: the
 * grant condition is derived entirely from Stripe's own record of money received
 * (read through stripe-service) plus billing's own ledger, so a request can only
 * make an ALREADY-EARNED grant land sooner, never conjure one. `settleWelcomeCompletion`
 * is called from every path that already has the org's paid-topups sum in hand
 * (composeAccountFunds, the checkout route) and, unconditionally, from the hourly
 * welcome-completion sweep — so it lands even for an org that never opens the app.
 *
 * ## Idempotency
 *
 * The PARTIAL unique index `idx_local_promos_org_promo (org_id, promo_code_id)
 * WHERE idempotency_key IS NULL` is the hard exactly-once guard. Concurrent
 * settles race on the INSERT; the loser reads `already_granted`. Replaying the
 * same payment event grants once.
 *
 * ## Fail loud
 *
 * A missing `welcome_completion` promo-code seed THROWS. Swallowing it would leave
 * a buyer short of the credit they were promised — the exact failure this feature
 * exists to remove. Note prod HAS lost promo-code seeds before (see CLAUDE.md
 * "Migrations are hand-journaled"), which is why the checkout discount is gated on
 * this seed existing: the discount can never be granted without the credit.
 */

import { and, eq, notExists, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  FREE_CREDIT_ENTITLEMENT_CENTS,
  FREE_CREDIT_PAID_TRIGGER_CENTS,
  WELCOME_COMPLETION_CODE,
  WELCOME_DISCOUNT_MIN_CHECKOUT_CENTS,
} from "../db/schema.js";
import { cmpCents, gte, subCents } from "./cents.js";
import { sumLocalPromoCreditsForOrg } from "./promos.js";
import { Decimal } from "decimal.js";

// System sentinel — the completion has no human user (it is platform-issued).
// Same convention as promos.ts grantCredit / internal transfer-brand.
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

const ZERO = "0.0000000000";

/**
 * Copy shown on the checkout page when NO up-front discount applies, so the buyer
 * knows the gift is coming before deciding to pay. Approved verbatim by the product
 * owner — do not reword, do not interpolate. (No em-dash: customer-facing copy.)
 */
export const WELCOME_COMPLETION_CHECKOUT_NOTICE =
  "You get $25 in free credits. $5 now, the rest once your payments reach $25.";

export class WelcomeCompletionPromoCodeMissingError extends Error {
  constructor() {
    super(
      `welcome-completion promo code seed missing: ${WELCOME_COMPLETION_CODE} (run migration 0029)`
    );
  }
}

function toCents(amountCents: number): string {
  return new Decimal(amountCents).toFixed(10);
}

async function findWelcomeCompletionCode() {
  const [row] = await db
    .select()
    .from(localPromoCodes)
    .where(eq(localPromoCodes.code, WELCOME_COMPLETION_CODE))
    .limit(1);
  return row ?? null;
}

/**
 * True when the `welcome_completion` ledger key exists, i.e. when a completion
 * grant is possible at all. The checkout discount gates on this so a discount can
 * never land without the matching credit grant.
 */
export async function welcomeCompletionCodeExists(): Promise<boolean> {
  return (await findWelcomeCompletionCode()) !== null;
}

export type SettleReason =
  | "granted"
  | "already_granted"
  | "no_account"
  | "not_eligible"
  | "payments_below_trigger"
  | "entitlement_already_full";

export interface WelcomeCompletionOutcome {
  granted: boolean;
  /** Amount granted by THIS call (canonical cents string); "0.…" when nothing was granted. */
  amountCents: string;
  reason: SettleReason;
}

const NOT_GRANTED = (reason: SettleReason): WelcomeCompletionOutcome => ({
  granted: false,
  amountCents: ZERO,
  reason,
});

/**
 * Grant the welcome-completion gift if it is earned and not yet granted.
 *
 * `paidTopupsCents` is the org's cumulative succeeded payments NET of refunds and
 * lost disputes — i.e. exactly the figure the callers already computed via
 * sumSucceededTopupsFor{Customer,Org}. Money that was given back does not earn the
 * gift.
 *
 * Idempotent and safe to call on every request. Fails loud.
 */
export async function settleWelcomeCompletion(
  orgId: string,
  paidTopupsCents: string
): Promise<WelcomeCompletionOutcome> {
  const [account] = await db
    .select({ eligible: billingAccounts.welcomeCompletionEligible })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);

  if (!account) return NOT_GRANTED("no_account");
  if (!account.eligible) return NOT_GRANTED("not_eligible");
  if (!gte(paidTopupsCents, toCents(FREE_CREDIT_PAID_TRIGGER_CENTS))) {
    return NOT_GRANTED("payments_below_trigger");
  }

  const giftedCents = await sumLocalPromoCreditsForOrg(orgId);
  const remainingCents = subCents(
    toCents(FREE_CREDIT_ENTITLEMENT_CENTS),
    giftedCents
  );
  if (cmpCents(remainingCents, ZERO) <= 0) {
    return NOT_GRANTED("entitlement_already_full");
  }

  const code = await findWelcomeCompletionCode();
  if (!code) throw new WelcomeCompletionPromoCodeMissingError();

  const inserted = await db
    .insert(localPromos)
    .values({
      orgId,
      userId: SYSTEM_USER_ID,
      amountCents: remainingCents,
      promoCodeId: code.id,
      description: `Welcome credits (2/2): $${new Decimal(remainingCents)
        .dividedBy(100)
        .toFixed(2)}`,
    })
    // (org, promo_code) uniqueness is PARTIAL (WHERE idempotency_key IS NULL,
    // migration 0025) — the conflict target must carry the predicate.
    .onConflictDoNothing({
      target: [localPromos.orgId, localPromos.promoCodeId],
      where: rawSql`idempotency_key IS NULL`,
    })
    .returning();

  if (inserted.length > 0) {
    return { granted: true, amountCents: remainingCents, reason: "granted" };
  }
  return NOT_GRANTED("already_granted");
}

export interface CheckoutWelcomeOffer {
  /** Apply a visible up-front discount to THIS checkout. */
  applyDiscount: boolean;
  /** Stripe coupon id to attach (only set when applyDiscount). */
  couponId: string | null;
  /** Show the "gift is coming" notice on the checkout page. */
  showNotice: boolean;
}

const NO_OFFER: CheckoutWelcomeOffer = {
  applyDiscount: false,
  couponId: null,
  showNotice: false,
};

/**
 * Decide what the checkout page should say / apply for this org's payment-mode
 * checkout.
 *
 * Discount rules, all of which must hold:
 *   - the org has NEVER paid before (`paidTopupsCents` is 0) — otherwise every
 *     later top-up would silently get $25 off forever;
 *   - the org still has free-credit entitlement left to advance;
 *   - the checkout is for at least WELCOME_DISCOUNT_MIN_CHECKOUT_CENTS ($50), so
 *     the post-discount charge still reaches the $25 that EARNS the gift (this is
 *     what makes it impossible to discount without the matching grant, and what
 *     keeps the charge away from $0);
 *   - a completion grant is actually possible (ledger key seeded) and a coupon is
 *     configured.
 *
 * When no discount applies, the notice is shown instead — but only to an org that
 * genuinely still has free credit coming. Telling an org with its full $25 already
 * gifted (or an org that is not eligible at all) that "the rest" is on its way
 * would be a lie.
 */
export async function decideCheckoutWelcomeOffer(
  orgId: string,
  paidTopupsCents: string,
  checkoutAmountCents: number
): Promise<CheckoutWelcomeOffer> {
  const [account] = await db
    .select({ eligible: billingAccounts.welcomeCompletionEligible })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  if (!account || !account.eligible) return NO_OFFER;

  const giftedCents = await sumLocalPromoCreditsForOrg(orgId);
  const remainingCents = subCents(
    toCents(FREE_CREDIT_ENTITLEMENT_CENTS),
    giftedCents
  );
  if (cmpCents(remainingCents, ZERO) <= 0) return NO_OFFER;

  const neverPaid = cmpCents(paidTopupsCents, ZERO) <= 0;
  const meetsFloor = checkoutAmountCents >= WELCOME_DISCOUNT_MIN_CHECKOUT_CENTS;
  const couponId = process.env.WELCOME_DISCOUNT_COUPON_ID?.trim() || null;
  const grantable = couponId !== null && (await welcomeCompletionCodeExists());

  if (neverPaid && meetsFloor && grantable) {
    return { applyDiscount: true, couponId, showNotice: false };
  }
  return { applyDiscount: false, couponId: null, showNotice: true };
}

/**
 * Org ids that could still earn the completion — the sweep's candidate set:
 * eligible accounts with no completion row yet. An org drops out permanently once
 * granted, so the set is bounded by recent signups, not by fleet size.
 *
 * Fails loud when the ledger key is missing (the sweep must not silently no-op).
 */
export async function listWelcomeCompletionCandidates(): Promise<string[]> {
  const code = await findWelcomeCompletionCode();
  if (!code) throw new WelcomeCompletionPromoCodeMissingError();

  const rows = await db
    .select({ orgId: billingAccounts.orgId })
    .from(billingAccounts)
    .where(
      and(
        eq(billingAccounts.welcomeCompletionEligible, true),
        notExists(
          db
            .select({ one: rawSql`1` })
            .from(localPromos)
            .where(
              and(
                eq(localPromos.orgId, billingAccounts.orgId),
                eq(localPromos.promoCodeId, code.id)
              )
            )
        )
      )
    );

  return rows.map((r) => r.orgId);
}
