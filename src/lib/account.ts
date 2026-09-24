import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, WELCOME_PROMO_CODE } from "../db/schema.js";
import { redeemPromoCode, PromoAlreadyRedeemedError } from "./promos.js";
import {
  ensureCustomer,
  getCustomerByOrgOrNull,
  type IdentityHeaders,
  type StripeCustomer,
} from "./stripe-service-client.js";
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

/**
 * The org's Stripe customer, CREATED the first time a flow that needs one runs.
 *
 * `findOrCreateAccount` creates the customer only on the fresh-INSERT branch, so
 * an org whose billing row was written by something else first never gets one:
 * the trial seed (an anonymous org, before any user exists) and the invite /
 * promise pre-creates in lib/promos all insert the row with no customer. When
 * that org is later claimed and reaches checkout, every read of "its customer"
 * answered empty and the session 502'd — prod 2026-09-22, every claimed
 * anonymous org.
 *
 * So the flows that genuinely NEED a customer (checkout, card setup) ask for one
 * here: read first, and only when none exists issue stripe-service's idempotent
 * `POST /v1/customers` (1:1 org<->customer is enforced there, so a race or a retry
 * returns the same customer). Called only from routes that carry a real end user
 * (`requireOrgHeaders`), so a customer is never minted for an org that is still
 * anonymous merely because something READ it — reads tolerate "no customer"
 * instead (see lib/balance).
 *
 * Fail loud: if the create does not produce a readable customer, throw.
 */
export async function ensureOrgStripeCustomer(
  identity: IdentityHeaders
): Promise<StripeCustomer> {
  const existing = await getCustomerByOrgOrNull(identity);
  if (existing) return existing;

  await ensureCustomer(identity);
  const created = await getCustomerByOrgOrNull(identity);
  if (!created) {
    throw new Error(
      `stripe-service created no customer for org ${identity["x-org-id"]}`
    );
  }
  return created;
}
