import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, customerBalanceTransactions } from "../db/schema.js";
import { createCustomer } from "./stripe.js";

// $2 trial credit on signup. Stored unsigned positive in balance_cents (cache),
// and as a negative amount_cents row on customer_balance_transactions (since
// credit-type rows have negative signed amounts per Stripe convention).
const WELCOME_GIFT_CENTS = "200";
const WELCOME_GIFT_SIGNED_CENTS = "-200";

/**
 * Find or auto-create a billing account for an org.
 * Uses INSERT ON CONFLICT to prevent duplicate Stripe customers
 * and double welcome gifts on concurrent requests.
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
      balanceCents: WELCOME_GIFT_CENTS,
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

  // Write welcome gift to ledger: type='gift', signed amount (negative = credit)
  await db
    .insert(customerBalanceTransactions)
    .values({
      orgId,
      userId,
      type: "gift",
      amountCents: WELCOME_GIFT_SIGNED_CENTS,
      status: "succeeded",
      description: "Trial gift: $2.00",
    });

  return updated;
}
