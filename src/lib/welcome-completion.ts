/**
 * Welcome-completion gift — the second half of the "$N in free credits" promise.
 *
 * ## The rule
 *
 * An org receives ITS OWN `free_credit_entitlement_cents` in free credits IN TOTAL,
 * welcome gift included. Signup grants only the `welcome` row ($5 today, for every
 * cohort), so the completion is worth the remainder. The remainder is DERIVED from
 * what the org has actually been gifted (SUM(local_promos)), never from a hardcoded
 * difference — so it stays correct across cohorts, if the welcome amount is
 * re-priced, or if the org never got a welcome row at all.
 *
 * The completion is EARNED once the org's cumulative SUCCEEDED payments reach ITS
 * OWN `free_credit_paid_trigger_cents`. The trigger is money actually received,
 * NOT usage consumed: the account model is threshold-postpaid (an org can consume
 * on credit before paying anything), and we must not gift credits to someone whose
 * card may still fail.
 *
 * ## Why the amounts live on the account
 *
 * Both figures are a PROPERTY OF THE ORG, decided once when its billing account is
 * created (migration 0032) and never moved afterwards. Re-pricing the offer changes
 * the COLUMN DEFAULT, which reaches future signups only — every existing customer
 * keeps the offer it signed up under, permanently, with no cutoff date to maintain
 * and no backfill. A third re-price grandfathers automatically for the same reason.
 * Accounts predating 0032 carry $25/$25; accounts created after it carry $400/$400.
 *
 * ## Who is excluded ("no backfill", precisely)
 *
 * Exactly one population: an org whose cumulative payments had ALREADY crossed the
 * trigger BEFORE WELCOME_COMPLETION_LAUNCH_AT_ISO. Granting those would be a
 * retroactive credit for a trigger satisfied before the offer existed, which the
 * product owner ruled out.
 *
 * Every OTHER pre-existing org earns it on its FUTURE payments, exactly like a
 * brand-new signup — which is the whole point of the automation: the orgs it was
 * built for signed up long ago, hold the $5 welcome row, and have not paid $25 yet.
 * (Migration 0029 first read "no backfill" as "every account that existed at ship
 * time is ineligible forever", which excluded 78 of 88 orgs wrongly and left the
 * founder hand-granting the remainder one at a time. Migration 0030 corrects it.)
 *
 * Billing does not store cumulative payments — it reads them, and it does not derive
 * the as-of-launch figure either: stripe-service answers it directly
 * (`sumPaidTopupsForOrgAsOf`), bounding payments AND returns to what Stripe had
 * created before that second. The answer is then FROZEN on the account, so it costs
 * at most one extra read per org, ever. Reading immutable history means it returns the same answer
 * every time it is computed; and an org created after launch has no pre-launch
 * payments by construction, so it can never be demoted.
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
  WELCOME_COMPLETION_CODE,
  WELCOME_COMPLETION_LAUNCH_AT_MS,
  WELCOME_COMPLETION_LAUNCH_AT_UNIX,
} from "../db/schema.js";
import { cmpCents, gte, subCents } from "./cents.js";
import { sumEntitlementGrantsForOrg } from "./promos.js";
import { markWelcomePromiseGranted } from "./free-credit-promises.js";
import { sumPaidTopupsForOrgAsOf } from "./stripe-service-client.js";
import { Decimal } from "decimal.js";

// System sentinel — the completion has no human user (it is platform-issued).
// Same convention as promos.ts grantCredit / internal transfer-brand.
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

const ZERO = "0.0000000000";

/** The org's own free-credit offer, as frozen on its billing account. */
export interface FreeCreditOffer {
  /** Total free credits this org may ever receive, welcome gift INCLUDED. */
  entitlementCents: number;
  /** Cumulative succeeded payments that earn this org's completion grant. */
  paidTriggerCents: number;
}

/** Whole dollars, e.g. 40000 → "$400". Amounts are always whole-dollar offers. */
function dollars(cents: number): string {
  return `$${new Decimal(cents).dividedBy(100).toFixed(0)}`;
}

/**
 * Copy shown on the checkout page when NO up-front discount applies, so the buyer
 * knows the gift is coming before deciding to pay. The SENTENCE is approved verbatim
 * by the product owner — do not reword it. The two figures are substituted from the
 * org's OWN offer, because they now differ per cohort and quoting the wrong one would
 * promise money we will not grant (or hide money we will). The "$5" is a literal on
 * purpose: the up-front welcome gift is $5 for every cohort.
 * (No em-dash: customer-facing copy.)
 */
export function welcomeCompletionCheckoutNotice(offer: FreeCreditOffer): string {
  return `You get ${dollars(offer.entitlementCents)} in free credits. $5 now, the rest once your payments reach ${dollars(offer.paidTriggerCents)}.`;
}


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


export type SettleReason =
  | "granted"
  | "already_granted"
  | "no_account"
  | "not_eligible"
  | "payments_below_trigger"
  | "entitlement_already_full"
  /** Payments had already crossed the trigger before the automation launched. */
  | "trigger_crossed_before_launch";

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
 * The grandfather check reads the SAME sum as of WELCOME_COMPLETION_LAUNCH_AT_ISO
 * (see the module doc) from stripe-service. It is asked HERE, lazily, inside the
 * one branch that needs it: it costs a stripe-service read that almost no call ever
 * makes, and asking it in one place is what makes every caller — the three request
 * paths and the hourly sweep — get the same answer for the same org by construction.
 * No caller can skip it, and none can supply its own version of it.
 *
 * Idempotent and safe to call on every request. Fails loud.
 */
export async function settleWelcomeCompletion(
  orgId: string,
  paidTopupsCents: string
): Promise<WelcomeCompletionOutcome> {
  const [account] = await db
    .select({
      eligible: billingAccounts.welcomeCompletionEligible,
      createdAt: billingAccounts.createdAt,
      entitlementCents: billingAccounts.freeCreditEntitlementCents,
      paidTriggerCents: billingAccounts.freeCreditPaidTriggerCents,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);

  if (!account) return NOT_GRANTED("no_account");
  if (!account.eligible) return NOT_GRANTED("not_eligible");
  // This org's OWN trigger, frozen when its account was created — never a
  // module-level constant, or a re-price would move every existing org's bar.
  if (!gte(paidTopupsCents, toCents(account.paidTriggerCents))) {
    return NOT_GRANTED("payments_below_trigger");
  }

  // Referral rewards are deliberately NOT counted here: they are additional money
  // earned by a separate promise at a separate bar, so letting a $500 referral
  // swallow the welcome remainder would replace the welcome offer instead of
  // stacking with it. An org that was never referred has no such rows, so this is
  // the same sum as before.
  const giftedCents = await sumEntitlementGrantsForOrg(orgId);
  const remainingCents = subCents(
    toCents(account.entitlementCents),
    giftedCents
  );
  if (cmpCents(remainingCents, ZERO) <= 0) {
    return NOT_GRANTED("entitlement_already_full");
  }

  // Grandfather check — the ONE population "no backfill" excludes. Reached only by
  // an org that pre-dates the launch AND has since crossed the trigger AND still has
  // entitlement left, and its outcome is terminal either way (excluded for good
  // below, or granted just after and then permanently entitlement-full), so this
  // read happens at most once per org. A post-launch org skips it entirely: it has
  // no pre-launch payments by construction, so asking would always answer zero.
  if (account.createdAt.getTime() < WELCOME_COMPLETION_LAUNCH_AT_MS) {
    const paidBeforeLaunchCents = await sumPaidTopupsForOrgAsOf(
      orgId,
      WELCOME_COMPLETION_LAUNCH_AT_UNIX
    );
    if (gte(paidBeforeLaunchCents, toCents(account.paidTriggerCents))) {
      // Freeze the answer: it is derived from immutable payment history, so
      // re-deriving it can only ever return the same thing.
      await db
        .update(billingAccounts)
        .set({ welcomeCompletionEligible: false, updatedAt: new Date() })
        .where(eq(billingAccounts.orgId, orgId));
      return NOT_GRANTED("trigger_crossed_before_launch");
    }
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
    // Close the org's `welcome` promise row so the dashboard stops listing it as
    // outstanding. The row is a mirror of the account columns this function already
    // decided against, so stamping it cannot change who gets what — and a missing
    // row (an account that predates the promise table) simply updates nothing.
    await markWelcomePromiseGranted(orgId, inserted[0].id);
    return { granted: true, amountCents: remainingCents, reason: "granted" };
  }
  return NOT_GRANTED("already_granted");
}

/**
 * The "gift is coming" copy for this org's payment-mode checkout page, quoting
 * THIS org's own offer — or null when no notice should be shown. Built here
 * rather than in the route so the figures can never drift from the account the
 * decision was made against.
 *
 * Shown only to an org that genuinely still has free credit coming. Telling an
 * org with its full entitlement already gifted (or one that is not eligible at
 * all) that "the rest" is on its way would be a lie.
 *
 * There is deliberately NO up-front discount path. Advancing the entitlement as
 * a pre-applied Stripe coupon was removed: it required a floor of
 * (entitlement + trigger) to keep the post-discount charge above the trigger
 * that EARNS the gift, and at the current $400 offer that floor is $800 — far
 * above any real first checkout, so the branch had been unreachable for new
 * signups long before it was deleted. The gift is granted after the fact by
 * `settleWelcomeCompletion`, which is the path onboarding actually uses. Do NOT
 * reintroduce a checkout-time discount: it is the one place a buyer can be
 * handed credit before the payment that earns it has cleared.
 */
export async function decideCheckoutWelcomeNotice(orgId: string): Promise<string | null> {
  const [account] = await db
    .select({
      eligible: billingAccounts.welcomeCompletionEligible,
      entitlementCents: billingAccounts.freeCreditEntitlementCents,
      paidTriggerCents: billingAccounts.freeCreditPaidTriggerCents,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  if (!account || !account.eligible) return null;

  const offer: FreeCreditOffer = {
    entitlementCents: account.entitlementCents,
    paidTriggerCents: account.paidTriggerCents,
  };

  // Same exclusion as settleWelcomeCompletion — the notice describes the WELCOME
  // entitlement, so referral rewards must not count against what is left of it.
  const giftedCents = await sumEntitlementGrantsForOrg(orgId);
  const remainingCents = subCents(toCents(offer.entitlementCents), giftedCents);
  if (cmpCents(remainingCents, ZERO) <= 0) return null;

  return welcomeCompletionCheckoutNotice(offer);
}

/**
 * Org ids that could still earn the completion — the sweep's candidate set:
 * eligible accounts with no completion row yet. An org drops out permanently once
 * granted, and an org excluded by the grandfather check drops out the first time it
 * is settled, so the set is every org that genuinely still has the gift coming:
 * new signups plus the pre-launch orgs that have not yet paid $25.
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
