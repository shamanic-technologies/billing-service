/**
 * Shared balance composition — credited (paid topups + local promos) − usage.
 *
 * Extracted so both the request path (customer_balance route) and the dunning
 * scheduler (lib/dunning) compute balance identically. Fail-loud: any
 * downstream error (stripe-service / runs-service) propagates to the caller.
 */

import { addCents, subCents, ZERO_CENTS } from "./cents.js";
import { sumLocalPromoCreditsForOrg } from "./promos.js";
import { fetchRunsOrgUsageTotal } from "./runs-client.js";
import {
  fetchOrgCustomerOrNull,
  sumSucceededTopupsForOrg,
  hasChargeablePmForOrg,
  getOrgCardCountryByOrg,
  isAutoReloadBlockedCountry,
  type StripeCustomer,
} from "./stripe-service-client.js";

export interface BalanceSnapshot {
  /**
   * The org's Stripe customer, or NULL when it has none.
   *
   * Null is an ordinary state, not a failure: a customer is created when an org
   * first pays or saves a card, so an org still walking the unauthenticated
   * onboarding holds only its trial seed and has no customer at all. Read it as
   * `customer?.email` — every consumer here wants nothing but the notification
   * recipient, and a customer-less org has none.
   */
  customer: StripeCustomer | null;
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
  /**
   * Platform usage from runs-service. This is the NET figure: any per-org usage
   * discount is applied ONCE, at cost-write time, inside runs-service — billing
   * reads it as-is and never re-applies a discount. See CLAUDE.md "Usage discount".
   */
  usageCents: string;
  /** Spendable balance = creditedCents − usageCents (net usage from runs). */
  balanceCents: string;
}

/** An org's credited total, and the paid half of it. */
export interface CreditedCents {
  /**
   * Paid succeeded topups only (excludes promos) — the cumulative-paid signal
   * that drives the derived postpaid tier.
   */
  paidTopupsCents: string;
  /** Paid topups + local promo grants. */
  creditedCents: string;
}

/**
 * How much has EVER been credited to this org — the ONE definition.
 *
 * Extracted so nothing composes that sum a second time: `computeBalance` below
 * subtracts usage from it, and lib/payment-stopped compares it against the
 * figure a failed reload streak froze (the same comparison lib/card-usability
 * and the campaign reload sweep make). Two places adding up "credited"
 * separately is how they start disagreeing about whether a streak is over.
 *
 * Costs one stripe-service read plus one local query; no runs-service hop, so a
 * caller that needs credited but not usage does not pay for usage.
 */
export async function composeCreditedCents(
  orgId: string,
  opts: { hasStripeCustomer?: boolean } = {}
): Promise<CreditedCents> {
  // An org with NO Stripe customer has no Stripe payments — a payment cannot
  // exist without one — so the paid half is a derived zero, not a read we skip
  // and hope about. Asking anyway would be one more call that can only 404.
  const hasStripeCustomer = opts.hasStripeCustomer ?? true;
  const [paidTopups, localCredits] = await Promise.all([
    hasStripeCustomer ? sumSucceededTopupsForOrg(orgId) : Promise.resolve(ZERO_CENTS),
    sumLocalPromoCreditsForOrg(orgId),
  ]);
  return {
    paidTopupsCents: paidTopups,
    creditedCents: addCents(paidTopups, localCredits),
  };
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
  const customer = await fetchOrgCustomerOrNull(orgId);
  // No Stripe customer → the org has never paid and holds no saved card, because
  // neither object can exist without one. So the three Stripe reads below are
  // answered by derivation rather than skipped: paid topups "0", no chargeable
  // PM, no card country. It leaves the org STRICTLY PREPAID — resolvePostpaidTier
  // grants no credit line without a chargeable card, so the floor is "0" — which
  // is exactly right for an org whose only money is a trial seed, and its credit
  // is spendable down to zero like anyone else's.
  //
  // This is NOT a fallback that hides an outage: `fetchOrgCustomerOrNull` returns
  // null ONLY on stripe-service's definite 404. Any other failure propagates.
  const hasStripeCustomer = customer !== null;
  const [credited, runsUsage, hasCardPm, cardCountry] = await Promise.all([
    composeCreditedCents(orgId, { hasStripeCustomer }),
    fetchRunsOrgUsageTotal(orgId, {}),
    hasStripeCustomer ? hasChargeablePmForOrg(orgId) : Promise.resolve(false),
    hasStripeCustomer ? getOrgCardCountryByOrg(orgId) : Promise.resolve(null),
  ]);
  const { paidTopupsCents: paidTopups, creditedCents } = credited;
  // runsUsage.spent_cents is already NET of any per-org usage discount (frozen at
  // cost-write in runs-service). Billing subtracts it verbatim — applying a
  // discount here again would double-count it.
  const balanceCents = subCents(creditedCents, runsUsage.spent_cents);
  return {
    customer,
    hasCardPm,
    cardCountry,
    autoReloadSupported: !isAutoReloadBlockedCountry(cardCountry),
    paidTopupsCents: paidTopups,
    creditedCents,
    usageCents: runsUsage.spent_cents,
    balanceCents,
  };
}
