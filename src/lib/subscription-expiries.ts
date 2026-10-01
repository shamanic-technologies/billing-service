/**
 * Subscription credit that EXPIRED unspent at a period boundary (lib/subscription,
 * migration 0056). Applied on the USAGE side through lib/transfer-usage, exactly
 * like a staff debit: it lowers both balances like spend, is never a negative
 * `local_promos` row (which every gift rule reads), and is shown as its own line.
 * Its own module so the usage choke point does not import the subscription engine.
 */
import { eq, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { subscriptionCreditExpiries } from "../db/schema.js";

/** Total credit expired for an org, as decimal cents. */
export async function sumSubscriptionExpiriesForOrg(orgId: string): Promise<string> {
  const [row] = await db
    .select({
      total: rawSql<string>`COALESCE(SUM(${subscriptionCreditExpiries.amountCents}), 0)::text`,
    })
    .from(subscriptionCreditExpiries)
    .where(eq(subscriptionCreditExpiries.orgId, orgId));
  return row?.total ?? "0";
}
