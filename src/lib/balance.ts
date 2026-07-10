/**
 * Shared balance composition — credited (paid topups + local promos) − usage.
 *
 * Extracted so both the request path (customer_balance route) and the dunning
 * scheduler (lib/dunning) compute balance identically. Fail-loud: any
 * downstream error (stripe-service / runs-service) propagates to the caller.
 */

import { addCents, subCents } from "./cents.js";
import { sumLocalPromoCreditsForOrg } from "./promos.js";
import { fetchRunsOrgUsageTotal } from "./runs-client.js";
import { getUsageDiscountPct, applyUsageDiscount } from "./usage-discount.js";
import {
  fetchOrgCustomer,
  sumSucceededTopupsForOrg,
  hasChargeablePmForOrg,
  getOrgCardCountryByOrg,
  isAutoReloadBlockedCountry,
  type StripeCustomer,
} from "./stripe-service-client.js";

export interface BalanceSnapshot {
  customer: StripeCustomer;
  hasCardPm: boolean;
  /** Issuing country of the card the reload would charge (null when no card PM). */
  cardCountry: string | null;
  /**
   * False when the saved card's issuing country can't be charged off_session (e.g.
   * India / RBI). The reload trigger skips these cards — see customer_balance authorize.
   */
  autoReloadSupported: boolean;
  /**
   * Paid succeeded topups only (excludes promos) — the cumulative-paid signal
   * that drives the derived postpaid tier (see lib/topup-tier). Distinct from
   * creditedCents, which also includes local promo grants.
   */
  paidTopupsCents: string;
  creditedCents: string;
  /** GROSS platform usage from runs-service (reporting truth — never discounted). */
  usageCents: string;
  /**
   * Per-org usage-discount percentage applied at composition (null = none).
   * A discounted org subtracts NET usage below, so its balance depletes slower.
   */
  discountPct: number | null;
  /** NET usage after discount = gross × (1 − pct/100). Equals usageCents when no discount. */
  netUsageCents: string;
  /** Spendable balance = creditedCents − netUsageCents (discount-adjusted). */
  balanceCents: string;
}

/**
 * Compose an org's balance from credited (paid topups + local promos) − usage.
 *
 * Reads from stripe-service via the user-less `/internal/<resource>/by-org/{orgId}`
 * routes (X-API-Key + org only) and from runs-service `/internal/org-usage-total` (org_id
 * query). There is NO end-user on this path — no x-user-id, no sentinel. The runs
 * read needs only org_id, so no identity is threaded anywhere.
 *
 * Fail-loud: any downstream error (stripe-service / runs-service) propagates.
 */
export async function computeBalance(orgId: string): Promise<BalanceSnapshot> {
  const customer = await fetchOrgCustomer(orgId);
  const [paidTopups, localCredits, runsUsage, hasCardPm, cardCountry, discountPct] =
    await Promise.all([
      sumSucceededTopupsForOrg(orgId),
      sumLocalPromoCreditsForOrg(orgId),
      fetchRunsOrgUsageTotal(orgId, {}),
      hasChargeablePmForOrg(orgId),
      getOrgCardCountryByOrg(orgId),
      getUsageDiscountPct(orgId),
    ]);
  const creditedCents = addCents(paidTopups, localCredits);
  // Discount reduces the usage billing subtracts (gross usage stays reporting
  // truth). netUsage === gross when discountPct is null → byte-identical balance.
  const netUsageCents = applyUsageDiscount(runsUsage.spent_cents, discountPct);
  const balanceCents = subCents(creditedCents, netUsageCents);
  return {
    customer,
    hasCardPm,
    cardCountry,
    autoReloadSupported: !isAutoReloadBlockedCountry(cardCountry),
    paidTopupsCents: paidTopups,
    creditedCents,
    usageCents: runsUsage.spent_cents,
    discountPct,
    netUsageCents,
    balanceCents,
  };
}
