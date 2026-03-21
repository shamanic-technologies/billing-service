import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { createCustomer, createBalanceTransaction } from "./stripe.js";

/**
 * Find or auto-create a billing account for an org.
 * Creates a Stripe customer and credits $2 trial balance on first access.
 */
export async function findOrCreateAccount(
  orgId: string,
  userId: string,
  wfHeaders: Record<string, string>
) {
  const [existing] = await db
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);

  if (existing) return existing;

  const stripeCustomer = await createCustomer(orgId, userId, undefined, wfHeaders);

  await createBalanceTransaction(
    orgId,
    userId,
    stripeCustomer.id,
    -200,
    "Trial credit: $2.00",
    undefined,
    wfHeaders
  );

  const [account] = await db
    .insert(billingAccounts)
    .values({
      orgId,
      stripeCustomerId: stripeCustomer.id,
      creditBalanceCents: 200,
    })
    .onConflictDoNothing()
    .returning();

  // Race condition: another request created it first
  if (!account) {
    const [refetched] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);
    return refetched;
  }

  return account;
}
