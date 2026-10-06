import { eq } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import {
  billingAccounts,
  LEGACY_FREE_CREDIT_OFFER,
  MATCH_FREE_CREDIT_OFFER,
  MATCH_MIN_RELOAD_THRESHOLD_CENTS,
  MATCH_OFFER_ENDS_AT_MS,
  MATCH_MIN_TOPUP_CENTS,
  type FreeCreditOfferKind,
} from "../db/schema.js";

/**
 * "We match your first $100" — the free-credit offer of every org created after
 * migration 0066 (owner 2026-10-06). Existing orgs keep their own offer ('legacy').
 *
 *   at creation  : $30, ONE `org_creation_bonus` row, whatever path created the org
 *                  (dashboard "New organization", anonymous onboarding, first touch)
 *   at $100 paid : the remainder (entitlement − every gift already counted against
 *                  it), i.e. +$70 — lib/welcome-completion, exactly once per org
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

/**
 * Whether this org may receive the match's $30 up-front gift. The match runs until
 * October 31, 2026 (MATCH_OFFER_ENDS_AT_ISO): an account created at or after it was
 * created with a ZERO entitlement (migration 0067), so that zero is the answer; an
 * org with no account yet is being created now, so the clock is. Legacy orgs are not
 * gated (unchanged).
 */
export async function matchUpFrontAllowed(orgId: string, now: Date = new Date()): Promise<boolean> {
  const [row] = await db
    .select({
      offer: billingAccounts.freeCreditOffer,
      entitlementCents: billingAccounts.freeCreditEntitlementCents,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  if (!row) return now.getTime() < MATCH_OFFER_ENDS_AT_MS;
  if (asFreeCreditOffer(row.offer) !== MATCH_FREE_CREDIT_OFFER) return true;
  return row.entitlementCents > 0;
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
