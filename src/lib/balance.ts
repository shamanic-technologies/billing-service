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
import {
  getCustomerByOrg,
  sumSucceededTopupsForCustomer,
  hasAttachedCardPm,
  type StripeCustomer,
  type IdentityHeaders,
} from "./stripe-service-client.js";

export interface BalanceSnapshot {
  customer: StripeCustomer;
  hasCardPm: boolean;
  creditedCents: string;
  usageCents: string;
  balanceCents: string;
}

export async function computeBalance(
  orgId: string,
  identity: IdentityHeaders
): Promise<BalanceSnapshot> {
  const customer = await getCustomerByOrg(identity);
  const [paidTopups, localCredits, runsUsage, hasCardPm] = await Promise.all([
    sumSucceededTopupsForCustomer(identity, customer.id),
    sumLocalPromoCreditsForOrg(orgId),
    fetchRunsOrgUsageTotal(orgId, identity),
    hasAttachedCardPm(identity, customer.id),
  ]);
  const creditedCents = addCents(paidTopups, localCredits);
  const balanceCents = subCents(creditedCents, runsUsage.spent_cents);
  return {
    customer,
    hasCardPm,
    creditedCents,
    usageCents: runsUsage.spent_cents,
    balanceCents,
  };
}
