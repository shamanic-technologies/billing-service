import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, creditLedger } from "../db/schema.js";
import { createCustomer, createBalanceTransaction } from "./stripe.js";

/**
 * Find or auto-create a billing account for an org.
 * Uses INSERT ON CONFLICT to prevent duplicate Stripe customers
 * and double welcome credits on concurrent requests.
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

  // Atomic insert — only one concurrent request wins
  const [inserted] = await db
    .insert(billingAccounts)
    .values({
      orgId,
      creditBalanceCents: 200,
    })
    .onConflictDoNothing()
    .returning();

  if (!inserted) {
    // Lost the race — another request created the account
    const [refetched] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);
    return refetched;
  }

  // We won — create Stripe customer and update the row
  const stripeCustomer = await createCustomer(orgId, userId, undefined, wfHeaders);

  const [updated] = await db
    .update(billingAccounts)
    .set({ stripeCustomerId: stripeCustomer.id, updatedAt: new Date() })
    .where(eq(billingAccounts.orgId, orgId))
    .returning();

  // Write welcome credit to ledger
  const [welcomeEntry] = await db
    .insert(creditLedger)
    .values({
      orgId,
      userId,
      type: "credit",
      amountCents: 200,
      status: "confirmed",
      source: "welcome",
      description: "Trial credit: $2.00",
    })
    .returning();

  // Fire-and-forget Stripe balance txn for welcome credit
  createBalanceTransaction(
    orgId,
    userId,
    stripeCustomer.id,
    -200,
    "Trial credit: $2.00",
    undefined,
    wfHeaders
  )
    .then((txn) => {
      db.update(creditLedger)
        .set({ stripeBalanceTxnId: txn.id, updatedAt: new Date() })
        .where(eq(creditLedger.id, welcomeEntry.id))
        .then(() => {})
        .catch(() => {});
    })
    .catch((err) => {
      console.error(
        "[billing-service] Welcome credit Stripe balance txn failed:",
        err
      );
    });

  return updated;
}
