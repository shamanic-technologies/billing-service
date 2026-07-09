import { Decimal } from "decimal.js";

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
 *   topups sum (`sumSucceededTopupsForOrg` / `sumSucceededTopupsForCustomer`).
 */
export function tierFor(cumulativePaidCents: string): TopupTier {
  const paid = new Decimal(cumulativePaidCents);
  if (paid.greaterThanOrEqualTo(TIER_HIGH_MIN)) {
    return { thresholdCents: -50000, amountCents: 50000 };
  }
  if (paid.greaterThanOrEqualTo(TIER_MID_MIN)) {
    return { thresholdCents: -20000, amountCents: 20000 };
  }
  return { thresholdCents: -5000, amountCents: 5000 };
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
