/**
 * POSTPAID: the one money action a client has is paying the WHOLE amount owed now
 * (owner 2026-10-21: « on doit juste pouvoir être prélevé de tout le montant »).
 * A postpaid org has no auto top-up and no "Add credit": it starts at $0, goes
 * negative, and is charged at the $50 / $200 / $500 steps and at month end. This
 * lets it settle early, on its saved card, for exactly what it owes.
 *
 * Example: balance -$12.17 → one $12.17 charge, balance $0. Nothing owed → 0
 * charged. The amount is the month-end settle's (`computeSettleCharge` on actual
 * usage), never restated, so a provisioned hold is never charged.
 */
import { cmpCents } from "./cents.js";
import { computeBalance, computeSettleBalanceCents } from "./balance.js";
import { computeSettleCharge } from "./month-end-sweep.js";
import { chargeOrgOnDemand } from "./on-demand-charge.js";
import {
  getOrgCardCountryByOrg,
  hasChargeablePmForOrg,
  isAutoReloadBlockedCountry,
} from "./stripe-service-client.js";

/** A postpaid org's credit line is real: a chargeable card in an off-session country. */
export async function hasPostpaidCreditLine(orgId: string): Promise<boolean> {
  const [hasCard, country] = await Promise.all([hasChargeablePmForOrg(orgId), getOrgCardCountryByOrg(orgId)]);
  return hasCard && !isAutoReloadBlockedCountry(country);
}

export class PayBalanceRefused extends Error {
  constructor(
    readonly code: "not_postpaid" | "balance_below_minimum_charge",
    readonly owedCents: number,
    message: string
  ) {
    super(message);
    this.name = "PayBalanceRefused";
  }
}

export interface PayBalanceResult {
  /** Whole cents charged now (0 when nothing was owed). */
  chargedCents: number;
  reference: string | null;
}

/**
 * Charge the org's saved card for exactly what it owes. Throws PayBalanceRefused
 * (owes less than a card can be charged) and OnDemandChargeError (no card,
 * declined, backoff, upstream) for the route to name.
 */
export async function payOutstandingBalance(orgId: string, paymentMode: string): Promise<PayBalanceResult> {
  if (paymentMode !== "postpaid") {
    throw new PayBalanceRefused(
      "not_postpaid",
      0,
      "Only an account that pays after use has a balance to pay off."
    );
  }
  const snapshot = await computeBalance(orgId);
  const settleBalance = await computeSettleBalanceCents(orgId, snapshot);
  if (cmpCents(settleBalance, "0") >= 0) return { chargedCents: 0, reference: null };
  const amount = computeSettleCharge(settleBalance);
  if (amount === 0) {
    throw new PayBalanceRefused(
      "balance_below_minimum_charge",
      Math.ceil(-Number(settleBalance)),
      "The amount owed is below the smallest amount a card can be charged. It is collected with the next charge."
    );
  }
  const result = await chargeOrgOnDemand(orgId, amount);
  return { chargedCents: amount, reference: result.reference };
}
