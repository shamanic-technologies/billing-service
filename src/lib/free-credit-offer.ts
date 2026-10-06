import { and, eq, sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import {
  ADMIN_GRANT_CODE,
  billingAccounts,
  localPromoCodes,
  localPromos,
  ORG_CREATION_BONUS_CODE,
  LEGACY_FREE_CREDIT_OFFER,
  MATCH_FREE_CREDIT_OFFER,
  MATCH_MIN_RELOAD_THRESHOLD_CENTS,
  MATCH_MIN_TOPUP_CENTS,
  SUBSCRIPTION_TRIAL_CODE,
  type FreeCreditOfferKind,
} from "../db/schema.js";

/**
 * "We match your first $100" — the free-credit offer of every org created after
 * migration 0066 (owner 2026-10-06). Existing orgs keep their own offer ('legacy').
 *
 *   at creation  : a $30 ADVANCE on the first payment (ONE `org_creation_bonus`
 *                  row, whatever path created the org), repaid by that payment and
 *                  never a gift (see getOnboardingAdvanceCents)
 *   at $100 paid : +$100 free (entitlement − every GIFT, the advance is none) —
 *                  lib/welcome-completion, exactly once per org
 *   never        : the per-person welcome gift, the trial seed, the welcome coupon
 *
 * The $30 is ONE ledger key on purpose: two up-front paths racing (the trial seed and
 * a first billing touch) both land on the same (org, org_creation_bonus) unique row,
 * so the up-front gift can never be paid twice.
 *
 * Top-ups by a match_100 org are at least $100 and its auto-reload threshold at least
 * $5. Its stored auto-topup amount + threshold are BINDING for a prepaid org (reload
 * that amount when the balance would fall below that threshold); every legacy org
 * keeps the derived ladder, byte-unchanged.
 */

export class TopupBelowMinimumError extends Error {
  readonly code: "topup_below_minimum" | "topup_threshold_below_minimum";
  readonly minimumCents: number;
  constructor(
    code: "topup_below_minimum" | "topup_threshold_below_minimum",
    minimumCents: number
  ) {
    super(
      code === "topup_below_minimum"
        ? `A top-up must be at least $${(minimumCents / 100).toFixed(2)}`
        : `The reload threshold must be at least $${(minimumCents / 100).toFixed(2)}`
    );
    this.code = code;
    this.minimumCents = minimumCents;
  }
}

export function asFreeCreditOffer(value: string | null | undefined): FreeCreditOfferKind {
  return value === MATCH_FREE_CREDIT_OFFER ? MATCH_FREE_CREDIT_OFFER : LEGACY_FREE_CREDIT_OFFER;
}

/**
 * The offer an org is under. An org with NO billing account yet is a NEW org: its
 * account will be created with the column default (match_100), so it already is one.
 */
export async function getOrgFreeCreditOffer(orgId: string): Promise<FreeCreditOfferKind> {
  const [row] = await db
    .select({ offer: billingAccounts.freeCreditOffer })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  return row ? asFreeCreditOffer(row.offer) : MATCH_FREE_CREDIT_OFFER;
}

export async function isMatchOfferOrg(orgId: string): Promise<boolean> {
  return (await getOrgFreeCreditOffer(orgId)) === MATCH_FREE_CREDIT_OFFER;
}

/** Refuse a top-up below the minimum for a match_100 org. Legacy orgs: no minimum. */
export function assertTopupMinimum(offer: FreeCreditOfferKind, amountCents: number): void {
  if (offer !== MATCH_FREE_CREDIT_OFFER) return;
  if (amountCents < MATCH_MIN_TOPUP_CENTS) {
    throw new TopupBelowMinimumError("topup_below_minimum", MATCH_MIN_TOPUP_CENTS);
  }
}

/** Refuse an auto-topup configuration below the minimums for a match_100 org. */
export function assertAutoTopupMinimums(
  offer: FreeCreditOfferKind,
  amountCents: number,
  thresholdCents: number
): void {
  assertTopupMinimum(offer, amountCents);
  if (offer !== MATCH_FREE_CREDIT_OFFER) return;
  if (thresholdCents < MATCH_MIN_RELOAD_THRESHOLD_CENTS) {
    throw new TopupBelowMinimumError(
      "topup_threshold_below_minimum",
      MATCH_MIN_RELOAD_THRESHOLD_CENTS
    );
  }
}

/** The reload a match_100 org configured, or null (legacy org, or auto-topup off). */
export interface ConfiguredReload {
  amountCents: number;
  thresholdCents: number;
}

/**
 * The org's OWN reload configuration when it binds (match_100 with auto-topup on),
 * clamped up to the minimums so a value stored before they existed can never reload
 * below them. Null for every legacy org: its reload stays the derived ladder.
 */
export function configuredReloadFor(account: {
  freeCreditOffer: string;
  topupAmountCents: number | null;
  topupThresholdCents: number | null;
}): ConfiguredReload | null {
  if (asFreeCreditOffer(account.freeCreditOffer) !== MATCH_FREE_CREDIT_OFFER) return null;
  if (account.topupAmountCents == null || account.topupThresholdCents == null) return null;
  return {
    amountCents: Math.max(account.topupAmountCents, MATCH_MIN_TOPUP_CENTS),
    thresholdCents: Math.max(account.topupThresholdCents, MATCH_MIN_RELOAD_THRESHOLD_CENTS),
  };
}

/** Where an org stands on its free-credit offer, ready for the dashboard (no browser money math). */
export interface FreeCreditStatus {
  offer: FreeCreditOfferKind;
  /** Total free credit the offer gives, every gift included. */
  entitlementCents: number;
  /** Free credit already received that counts toward the offer. */
  receivedCents: string;
  /** Free credit still to come (0 once granted, or when nothing more can come). */
  pendingCents: string;
  /** Cumulative payments that unlock the pending credit. */
  paidTriggerCents: number;
  /** What the org still has to pay to unlock it (0 when nothing is pending or already reached). */
  remainingToPayCents: string;
}

export function computeFreeCreditStatus(params: {
  offer: FreeCreditOfferKind;
  entitlementCents: number;
  paidTriggerCents: number;
  eligible: boolean;
  receivedCents: string;
  paidTopupsCents: string;
}): FreeCreditStatus {
  const received = new Decimal(params.receivedCents);
  const pending = params.eligible
    ? Decimal.max(0, new Decimal(params.entitlementCents).minus(received))
    : new Decimal(0);
  const remainingToPay = pending.greaterThan(0)
    ? Decimal.max(0, new Decimal(params.paidTriggerCents).minus(params.paidTopupsCents))
    : new Decimal(0);
  return {
    offer: params.offer,
    entitlementCents: params.entitlementCents,
    receivedCents: received.toFixed(10),
    pendingCents: pending.toFixed(10),
    paidTriggerCents: params.paidTriggerCents,
    remainingToPayCents: remainingToPay.toFixed(10),
  };
}

/**
 * The $30 a match_100 org receives at creation is an ADVANCE on its first payment,
 * not a gift (owner 2026-10-06: « on déduit du montant que les users vont payer en
 * prepaid … S'ils paient $200, ils verront $30 + $170. Ne labelise pas les $30 en
 * gift car ils l'ont payé »). The card is charged in full; the first payments
 * repay it, so a $200 payment leaves credited at $200 ($30 advance + $170), never $230.
 *
 * The ledger row (`org_creation_bonus`) is unchanged; what moves is how much of it
 * still counts: credited = paid + local credits − repaid, with
 * repaid = min(advance, cumulative paid). A legacy org's bonus is a gift: 0 repaid.
 * Every credited composition goes through `composeCreditedFromParts` so the account
 * read, the balance path and the grant route cannot disagree.
 */
export async function getOnboardingAdvanceCents(orgId: string): Promise<string> {
  if (!(await isMatchOfferOrg(orgId))) return "0.0000000000";
  const [row] = await db
    .select({ amountCents: localPromos.amountCents })
    .from(localPromos)
    .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
    .where(and(eq(localPromos.orgId, orgId), eq(localPromoCodes.code, ORG_CREATION_BONUS_CODE)))
    .limit(1);
  return new Decimal(row?.amountCents ?? 0).toFixed(10);
}

/**
 * The subscription payment that ENDS a free trial pays a DEBT, the trial credit
 * already given; it never adds credit (owner 2026-10-06: « the payment of the free
 * trial is a debt due paid, it should NEVER add credits »). The trial grants
 * (`trial_seed`, `subscription_trial`) stay credits, listed and labelled as they
 * are; it is the PAYMENT that counts 0 toward credited. From the 2nd period on, a
 * monthly charge adds credit as before.
 *
 * Which payment: the FIRST paid charge of every plan that had a trial, capped at
 * the trial credit it repays (its first
 * period starts where the trial ended, or now on "start now"). A plan with no trial
 * (a second plan, charged at start) repays nothing; a trial cancelled before any
 * payment keeps its trial credit (nothing paid, nothing repaid).
 */
export async function getTrialRepaymentCents(orgId: string): Promise<string> {
  // Capped at the trial credit it repays: the `subscription_trial` grant plus every
  // non-staff credit the org held before it (the grant tops credit UP TO the trial
  // amount, so those are part of the trial's $99: a `trial_seed`, a `welcome`). A
  // plan priced above that adds the difference as credit, as any payment does.
  const rows = (await db.execute(sql`
    SELECT LEAST(
      (SELECT COALESCE(SUM(c.amount_cents), 0)
         FROM subscription_charges c
         JOIN subscriptions s ON s.id = c.subscription_id
        WHERE c.org_id = ${orgId}
          AND c.status = 'paid'
          AND s.trial_started_at IS NOT NULL
          AND c.period_start = (
            SELECT MIN(c2.period_start) FROM subscription_charges c2
             WHERE c2.subscription_id = c.subscription_id
          )),
      (SELECT COALESCE(SUM(p.amount_cents), 0)
         FROM local_promos p
         JOIN local_promo_codes pc ON pc.id = p.promo_code_id
         JOIN local_promos t ON t.org_id = p.org_id
         JOIN local_promo_codes tc ON tc.id = t.promo_code_id AND tc.code = ${SUBSCRIPTION_TRIAL_CODE}
        WHERE p.org_id = ${orgId}
          AND (p.id = t.id OR (p.created_at < t.created_at AND pc.code <> ${ADMIN_GRANT_CODE})))
    )::text AS total
  `)) as unknown as Array<{ total: string }>;
  return new Decimal(rows[0]?.total ?? 0).toFixed(10);
}

export interface CreditedParts {
  creditedCents: string;
  /** The org's onboarding advance (0 for a legacy org). */
  advanceCents: string;
  /** How much of it its payments have repaid so far. */
  advanceRepaidCents: string;
  /** Paid money that repaid a free trial and therefore added no credit. */
  trialRepaidCents: string;
}

/**
 * credited = paid + local credits − (payments that repay a debt): the trial-end
 * subscription payment first (it repays the trial credit), then the match_100
 * onboarding advance out of what remains paid. Every credited figure (account read,
 * balance path, grant route) goes through here, so they cannot disagree.
 */
export function composeCreditedFromParts(
  paidTopupsCents: string,
  localCreditsCents: string,
  advanceCents: string,
  trialRepaymentCents: string = "0"
): CreditedParts {
  const paid = Decimal.max(0, new Decimal(paidTopupsCents));
  const trialRepaid = Decimal.min(Decimal.max(0, new Decimal(trialRepaymentCents)), paid);
  const repaid = Decimal.min(new Decimal(advanceCents), paid.minus(trialRepaid));
  return {
    creditedCents: new Decimal(paidTopupsCents)
      .plus(localCreditsCents)
      .minus(trialRepaid)
      .minus(repaid)
      .toFixed(10),
    advanceCents: new Decimal(advanceCents).toFixed(10),
    advanceRepaidCents: repaid.toFixed(10),
    trialRepaidCents: trialRepaid.toFixed(10),
  };
}
