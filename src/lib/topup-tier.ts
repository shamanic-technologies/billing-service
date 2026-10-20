import { Decimal } from "decimal.js";
import type { PaymentMode } from "./payment-mode-types.js";
import type { ConfiguredReload } from "./free-credit-offer.js";

/**
 * Threshold-based postpaid top-up tiers (Google/Meta-Ads billing cadence).
 *
 * Instead of charging a fixed daily amount, the org's balance is allowed to go
 * NEGATIVE down to a credit-line floor (`thresholdCents`, negative). A reload of
 * the fixed `amountCents` fires only when spend crosses that floor — so a
 * $32/day org is charged ~every 1.5 days, not daily. The magnitudes are equal
 * (|threshold| === amount) so exactly one charge clears one crossed line.
 *
 * The tier is DERIVED (no storage) from the org's cumulative succeeded topups —
 * the SAME "paid topups" sum the balance path already computes. The credit line
 * grows with trust: the more an org has already paid, the larger its line.
 *
 * The stored billing_accounts.topup_amount_cents / topup_threshold_cents columns
 * are used ONLY as the "auto-topup enabled" flag (non-null ⇒ enabled). The
 * effective (amount, threshold) come from tierFor().
 */
export interface TopupTier {
  /**
   * NEGATIVE credit-line floor, integer cents. The balance may run this far
   * below zero before a top-up charge fires (true postpaid).
   */
  thresholdCents: number;
  /** Fixed reload amount, integer cents. Magnitude equals |thresholdCents|. */
  amountCents: number;
}

// Cumulative-paid breakpoints (integer cents).
const TIER_HIGH_MIN = 100000; // $1000 paid → $500 line
const TIER_MID_MIN = 20000; //   $200 paid  → $200 line

/**
 * Resolve the postpaid tier for an org from its cumulative succeeded topups.
 *
 * @param cumulativePaidCents decimal-cents string (numeric(16,10)) — the paid
 *   topups sum (`sumSucceededTopupsForOrg`), which spans every acquirer.
 */
export function tierFor(cumulativePaidCents: string): TopupTier {
  const paid = new Decimal(cumulativePaidCents);
  if (paid.greaterThanOrEqualTo(TIER_HIGH_MIN)) {
    return { thresholdCents: -50000, amountCents: 50000 };
  }
  if (paid.greaterThanOrEqualTo(TIER_MID_MIN)) {
    return { thresholdCents: -20000, amountCents: 20000 };
  }
  return { thresholdCents: -POSTPAID_RELOAD_STEP_MIN_CENTS, amountCents: POSTPAID_RELOAD_STEP_MIN_CENTS };
}

/**
 * The smallest reload step a POSTPAID org can be set to: the ladder's first rung
 * ($50). The postpaid arming writes it, and PATCH /v1/accounts/auto_topup accepts
 * it on a postpaid org, so the two paths can never disagree about one org (prod
 * 2026-10-21, LBVisible: arming set $50, the configure path refused $50 under the
 * match_100 prepaid $100 minimum).
 */
export const POSTPAID_RELOAD_STEP_MIN_CENTS = 5000;

/**
 * Whether an org's automatic charge is ARMED (it still needs a chargeable card to
 * fire). A POSTPAID org is always armed: its credit line is what postpaid IS (owner
 * 2026-10-21: « LE CONCEPT DU POST PAID C'EST QUE LE USER PART DE 0, VA EN NEGATIF,
 * ET ON LE CHARGE TOUS LES $50, $200, ETC »), so no stored toggle can turn it into
 * "stops at $0". Its client-side brakes are the monthly charge limit and removing
 * the card. A SUBSCRIPTION org never is. A PREPAID org is armed iff its stored
 * auto top-up columns are set (they are its enabled flag).
 *
 * Every reader of "is auto top-up on" goes through this, never the bare columns.
 */
export function autoTopupArmed(account: {
  paymentMode: string;
  topupAmountCents: number | null;
  topupThresholdCents: number | null;
}): boolean {
  if (account.paymentMode === "postpaid") return true;
  if (account.paymentMode === "subscription") return false;
  return account.topupAmountCents != null && account.topupThresholdCents != null;
}

/**
 * Resolve an org's effective postpaid credit-line for a spend decision.
 *
 * An org has a NEGATIVE credit-line floor only when auto-topup can actually
 * fire: config enabled AND a chargeable card AND a non-blocked issuing country
 * (e.g. India / RBI off_session cards can't be reloaded). Otherwise the org is
 * strictly prepaid — floor "0" — and behaves exactly as pre-postpaid.
 *
 * Returns the derived `tier` (null when strictly prepaid) and the floor as a
 * decimal-cents string. Single source of the floor formula: shared by authorize
 * (sufficiency + reload target) and the read-only affordability pre-flight, so
 * the two can never drift on when an org is "still within its line".
 */
export function resolvePostpaidTier(params: {
  topupEnabled: boolean;
  hasCardPm: boolean;
  autoReloadSupported: boolean;
  paidTopupsCents: string;
  /**
   * The org's chosen payment mode (lib/payment-mode). Absent = postpaid, which is
   * every org that has not chosen otherwise.
   */
  paymentMode?: PaymentMode;
  /**
   * The org's OWN reload configuration when it binds (a match_100 org, see
   * lib/free-credit-offer `configuredReloadFor`); null/absent = the derived ladder.
   */
  configuredReload?: ConfiguredReload | null;
}): { tier: TopupTier | null; thresholdCents: string } {
  // SUBSCRIPTION never reloads and extends no credit: its money is the monthly
  // invoice Stripe charges on its own schedule, and spend stops at zero (owner
  // rule). Whatever the stored auto-top-up flag says.
  if (params.paymentMode === "subscription") return { tier: null, thresholdCents: "0" };
  const canReload =
    params.topupEnabled && params.hasCardPm && params.autoReloadSupported;
  if (!canReload) return { tier: null, thresholdCents: "0" };
  // PREPAID extends no credit: the floor is ZERO whatever the org has paid. Auto
  // top-up still reloads the ladder's amount, but only once the next run would
  // take the balance below zero — so a prepaid org never spends money it has not
  // paid in first.
  const tier = reloadTierFor(
    params.paidTopupsCents,
    params.paymentMode ?? "postpaid",
    params.configuredReload
  );
  return { tier, thresholdCents: String(tier.thresholdCents) };
}

/**
 * The reload tier for an org whose auto top-up is known to be able to fire (the
 * caller already checked config + card + country). Postpaid → the credit-line
 * ladder; prepaid → the same reload amount at a zero floor.
 */
export function reloadTierFor(
  paidTopupsCents: string,
  paymentMode: PaymentMode,
  configuredReload?: ConfiguredReload | null
): TopupTier {
  if (paymentMode === "subscription") {
    // Unreachable by construction (resolvePostpaidTier grants a subscription org no
    // tier, its auto top-up is disarmed on entry and refused after). A caller here
    // is about to compute a reload billing must never fire.
    throw new Error("[billing-service] a subscription org has no reload tier");
  }
  const ladder = tierFor(paidTopupsCents);
  // A match_100 / agent_api org's own configuration binds a PREPAID org only:
  // it reloads its amount when the balance would fall below its POSITIVE
  // threshold. POSTPAID is the Google-Ads credit line (owner 2026-10-13: « on peut
  // s'inspirer de GAds et remettre du post paid »): the ladder alone, $50 → $200 →
  // $500, whatever amount was stored for a prepaid top-up.
  if (configuredReload && paymentMode === "prepaid") {
    return {
      thresholdCents: configuredReload.thresholdCents,
      amountCents: configuredReload.amountCents,
    };
  }
  return paymentMode === "prepaid"
    ? { thresholdCents: 0, amountCents: ladder.amountCents }
    : ladder;
}

/**
 * Cents to charge to lift `currentBalanceCents` up to `targetCents`, in whole
 * multiples of `unitCents` (the tier reload amount). Returns 0 when the balance
 * is already at/above target. Rounds the multiple UP so one settle fully clears
 * the deficit past the target.
 *
 * Shared by every reload path: authorize (target = threshold + required),
 * usage_apply (target = threshold), and the month-end sweep (target = "0").
 */
export function computeTopupCharge(
  currentBalanceCents: string,
  targetCents: string,
  unitCents: number
): number {
  const deficit = new Decimal(targetCents).minus(currentBalanceCents);
  if (deficit.lessThanOrEqualTo(0)) return 0;
  const multiples = deficit
    .dividedBy(unitCents)
    .toDecimalPlaces(0, Decimal.ROUND_CEIL)
    .toNumber();
  return multiples * unitCents;
}
