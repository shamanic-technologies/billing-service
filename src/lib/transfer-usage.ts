/**
 * A brand transfer moves HISTORY, not MONEY.
 *
 * When a brand moves to another org, runs-service moves the brand's cost rows
 * with it. billing derives each org's usage from those rows, so on its own the
 * move would make the TARGET owe spend the SOURCE already paid for, and free the
 * source of it. The owner's rule is the opposite: the agency already paid, and
 * after a transfer both orgs read exactly the balance they read before.
 *
 * `brand_transfers` records what runs-service moved (migration 0051). Every read
 * of an org's usage goes through this module, which adds the moved figures back
 * to the source org and takes them off the target org. The correction lives on
 * the USAGE side, never as a credit, for two reasons:
 *   - one credit row cannot keep both balances exact: the spendable balance
 *     subtracts actual + provisioned usage while the displayed balance subtracts
 *     actual only, and a transferred brand can carry stuck provisioned holds
 *     (Doc Dinners on the agency org: $71.68 across 1,056 rows in prod);
 *   - a credit would be a `local_promos` row, which every gift / welcome /
 *     referral rule reads — a negative gift on the source and a four-figure gift
 *     on the target would reach all of them.
 *
 * Usage stays what it was on both sides, so `usage_cents`, `balance_cents` and
 * `actual_balance_cents` are unchanged to the cent on both orgs.
 *
 * Staff debits (lib/staff-debits.ts, migration 0053) ride the SAME choke point, for
 * the same reason: a debit must lower both balances exactly like spend, and must
 * not be a `local_promos` row. Both usage figures below therefore include the org's
 * staff debits, and carry them separately as `staff_debits_cents` so a display can
 * show the debit as its own line rather than as campaign usage.
 */

import { eq, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { brandTransfers } from "../db/schema.js";
import { addCents, cmpCents } from "./cents.js";
import {
  fetchRunsOrgActualUsageTotal,
  fetchRunsOrgUsageTotal,
  type RunsOrgActualUsageTotalResult,
  type RunsOrgUsageTotalResult,
} from "./runs-client.js";
import { sumStaffDebitsForOrg } from "./staff-debits.js";
import { sumSubscriptionExpiriesForOrg } from "./subscription-expiries.js";

export interface TransferUsageAdjustment {
  /** Added to the org's net PROJECTED usage (actual + provisioned). */
  usageCents: string;
  /** Added to the org's net ACTUALIZED usage. */
  actualCents: string;
}

/**
 * The correction to add to an org's runs-service usage: moved-out figures back
 * in (positive), moved-in figures back out (negative). "0" / "0" for an org that
 * was never part of a transfer, which is every org but a handful.
 */
export async function getTransferUsageAdjustment(
  orgId: string
): Promise<TransferUsageAdjustment> {
  const rows = await db
    .select({
      usage: sql<string>`COALESCE(SUM(CASE WHEN ${brandTransfers.sourceOrgId} = ${orgId} THEN ${brandTransfers.movedUsageNetCents} ELSE 0 END)
                          - SUM(CASE WHEN ${brandTransfers.targetOrgId} = ${orgId} THEN ${brandTransfers.movedUsageNetCents} ELSE 0 END), 0)::text`,
      actual: sql<string>`COALESCE(SUM(CASE WHEN ${brandTransfers.sourceOrgId} = ${orgId} THEN ${brandTransfers.movedActualNetCents} ELSE 0 END)
                           - SUM(CASE WHEN ${brandTransfers.targetOrgId} = ${orgId} THEN ${brandTransfers.movedActualNetCents} ELSE 0 END), 0)::text`,
    })
    .from(brandTransfers)
    .where(or(eq(brandTransfers.sourceOrgId, orgId), eq(brandTransfers.targetOrgId, orgId)));
  return { usageCents: rows[0]?.usage ?? "0", actualCents: rows[0]?.actual ?? "0" };
}

/**
 * runs-service's figure, corrected. An org never part of a transfer gets the
 * runs-service string back untouched (same value AND same formatting).
 */
function adjusted(runsCents: string, adjustmentCents: string): string {
  return cmpCents(adjustmentCents, "0") === 0 ? runsCents : addCents(runsCents, adjustmentCents);
}

/**
 * Staff debits and expired subscription credit the org carries — both already
 * INCLUDED in `spent_cents`, not on top of it.
 */
export interface StaffDebitsPart {
  staff_debits_cents: string;
  subscription_expired_cents: string;
}

/**
 * The org's net projected usage (what the spendable balance subtracts), with any
 * brand transfer's history left on the org that paid for it, plus its staff debits.
 */
export async function fetchOrgUsageTotal(
  orgId: string,
  wfHeaders: Record<string, string>
): Promise<RunsOrgUsageTotalResult & StaffDebitsPart> {
  const [runs, adj, debits, expired] = await Promise.all([
    fetchRunsOrgUsageTotal(orgId, wfHeaders),
    getTransferUsageAdjustment(orgId),
    sumStaffDebitsForOrg(orgId),
    sumSubscriptionExpiriesForOrg(orgId),
  ]);
  return {
    ...runs,
    spent_cents: adjusted(adjusted(adjusted(runs.spent_cents, adj.usageCents), debits), expired),
    staff_debits_cents: debits,
    subscription_expired_cents: expired,
  };
}

/**
 * The org's net actualized usage (what the displayed balance subtracts), with any
 * brand transfer's history left on the org that paid for it, plus its staff debits.
 */
export async function fetchOrgActualUsageTotal(
  orgId: string,
  wfHeaders: Record<string, string>
): Promise<RunsOrgActualUsageTotalResult & StaffDebitsPart> {
  const [runs, adj, debits, expired] = await Promise.all([
    fetchRunsOrgActualUsageTotal(orgId, wfHeaders),
    getTransferUsageAdjustment(orgId),
    sumStaffDebitsForOrg(orgId),
    sumSubscriptionExpiriesForOrg(orgId),
  ]);
  return {
    spent_cents: adjusted(adjusted(adjusted(runs.spent_cents, adj.actualCents), debits), expired),
    staff_debits_cents: debits,
    subscription_expired_cents: expired,
  };
}
