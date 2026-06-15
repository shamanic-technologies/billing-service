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
  fetchOrgCustomer,
  sumSucceededTopupsForOrg,
  hasChargeablePmForOrg,
  type StripeCustomer,
} from "./stripe-service-client.js";

export interface BalanceSnapshot {
  customer: StripeCustomer;
  hasCardPm: boolean;
  creditedCents: string;
  usageCents: string;
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
  const [paidTopups, localCredits, runsUsage, hasCardPm] = await Promise.all([
    sumSucceededTopupsForOrg(orgId),
    sumLocalPromoCreditsForOrg(orgId),
    fetchRunsOrgUsageTotal(orgId, {}),
    hasChargeablePmForOrg(orgId),
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
