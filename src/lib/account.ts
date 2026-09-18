import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, WELCOME_PROMO_CODE } from "../db/schema.js";
import { redeemPromoCode, PromoAlreadyRedeemedError } from "./promos.js";
import { ensureCustomer } from "./stripe-service-client.js";
import { hasTrialSeed } from "./trial-seed.js";

/**
 * Find or atomically create a billing account for an org.
 *
 * On fresh-create the winner:
 *   1. INSERT billing_accounts via ON CONFLICT DO NOTHING
 *   2. Ensures Stripe customer exists in stripe-service (idempotent SS-side)
 *   3. Redeems the welcome promo (UNIQUE (org_id, promo_code_id) makes this idempotent)
 *
 * Lost-race readers refetch and return the existing row with no side effects.
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

  const [inserted] = await db
    .insert(billingAccounts)
    .values({ orgId })
    .onConflictDoNothing()
    .returning();

  if (!inserted) {
    const [refetched] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);
    return refetched;
  }

  await ensureCustomer({
    "x-org-id": orgId,
    "x-user-id": userId,
    ...wfHeaders,
  });

  // An org seeded for the unauthenticated trial gets its welcome at SIGNUP, as the
  // REMAINDER (welcome − seeded) — see lib/trial-seed.ts. Normally the seed created
  // the account, so this branch is not reached for one; the check closes the race
  // where a first spend and the seed arrive together, in the only safe direction
  // (never grant a full welcome on top of a seed).
  if (!(await hasTrialSeed(orgId))) {
    try {
      await redeemPromoCode(orgId, userId, WELCOME_PROMO_CODE);
    } catch (err) {
      if (!(err instanceof PromoAlreadyRedeemedError)) throw err;
    }
  }

  return inserted;
}
