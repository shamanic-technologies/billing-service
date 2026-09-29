/**
 * Shared balance composition — credited (paid topups + local promos) − usage.
 *
 * Extracted so both the request path (customer_balance route) and the dunning
 * scheduler (lib/dunning) compute balance identically. Fail-loud: any
 * downstream error (stripe-service / runs-service) propagates to the caller.
 */

import { addCents, subCents } from "./cents.js";
import { sumLocalPromoCreditsForOrg } from "./promos.js";
import { fetchOrgActualUsageTotal, fetchOrgUsageTotal } from "./transfer-usage.js";
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
export async function composeCreditedCents(orgId: string): Promise<CreditedCents> {
  // ALWAYS asked, customer or not. stripe-service's payment summary spans every
  // acquirer that has taken money for this org and answers `totals: []` for an
  // org that has paid nothing, so it never needs a Stripe customer to exist. An
  // org paying through Revolut has NO Stripe customer by design, and gating this
  // read on one made its completed top-ups vanish from its balance.
  const [paidTopups, localCredits] = await Promise.all([
    sumSucceededTopupsForOrg(orgId),
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
  // The Stripe customer is read for ONE thing: the notification recipient. It
  // must NOT gate the money reads below. An org paying through Revolut has no
  // Stripe customer by design, yet it pays and saves a card — stripe-service's
  // payment summary and payment-method reads answer for whichever acquirer holds
  // the org, so they are always asked. An org with no customer on ANY acquirer
  // (an anonymous onboarding on its trial seed) reads as paid "0" and no card,
  // because those reads say so, not because this code assumes it: strictly
  // prepaid, floor "0", credit spendable down to zero.
  //
  // `fetchOrgCustomerOrNull` returns null ONLY on stripe-service's definite 404.
  // Any other failure propagates.
  const [customer, credited, runsUsage, hasCardPm, cardCountry] = await Promise.all([
    fetchOrgCustomerOrNull(orgId),
    composeCreditedCents(orgId),
    fetchOrgUsageTotal(orgId, {}),
    hasChargeablePmForOrg(orgId),
    getOrgCardCountryByOrg(orgId),
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

/**
 * The balance a SETTLE charges against: credited − ACTUAL usage only.
 *
 * `balanceCents` (the spendable balance) also subtracts PROVISIONED holds — the
 * worst-case reservation a run takes before it spends. That is right for
 * deciding whether the next run may START, and wrong for taking money: a hold is
 * later actualized at its real cost or cancelled outright, and a settle that
 * charged it would collect money for work that never happened. Owner rule: a
 * settle charges actual usage only. Every path that settles a balance to zero —
 * the month-end sweep, the switch to prepaid, the card-change settle, the charge
 * schedule's month-end event — reads this figure, never `balanceCents`.
 *
 * One runs-service read on top of the snapshot the caller already holds.
 * Fail-loud: a runs-service error propagates.
 */
export async function computeSettleBalanceCents(
  orgId: string,
  snapshot: Pick<BalanceSnapshot, "creditedCents">
): Promise<string> {
  const actual = await fetchOrgActualUsageTotal(orgId, {});
  return subCents(snapshot.creditedCents, actual.spent_cents);
}
