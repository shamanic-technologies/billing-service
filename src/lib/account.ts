import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  billingAccounts,
  MATCH_FREE_CREDIT_OFFER,
  WELCOME_PROMO_CODE,
} from "../db/schema.js";
import {
  grantOrgCreationBonus,
  redeemPromoCode,
  PromoAlreadyRedeemedError,
} from "./promos.js";
import {
  ensureCustomer,
  getCustomerByOrgOrNull,
  getOrgAcquirer,
  LEGACY_PM_GATE_ACQUIRER,
  type IdentityHeaders,
  type StripeCustomer,
} from "./stripe-service-client.js";
import { hasTrialSeed } from "./trial-seed.js";
import {
  claimWelcomeForPerson,
  personIdOrNull,
  withdrawFreeCreditOffer,
} from "./welcome-recipient.js";

/**
 * Find or atomically create a billing account for an org.
 *
 * On fresh-create the winner:
 *   1. INSERT billing_accounts via ON CONFLICT DO NOTHING and, in the SAME
 *      transaction, binds the calling person's welcome to this org — or, when that
 *      person's welcome already lives on another org, sets this account's own
 *      free-credit offer to zero (lib/welcome-recipient). One transaction, so a
 *      concurrent reader of the new row never sees the offer before it is decided.
 *   2. Redeems the welcome promo only when this org holds the person's welcome
 *      (UNIQUE (org_id, promo_code_id) makes the redeem idempotent)
 *
 * The welcome is once per PERSON: a second org the same person creates gets none.
 * A caller carrying no person (the platform sentinel) keeps the historical per-org
 * behaviour, loudly logged — billing cannot tell whose org it is.
 *
 * It creates NO Stripe customer. Until 2026-09-27 it did, on every fresh account,
 * so every new org got a live Stripe customer carrying whoever was acting's email
 * the moment its account was first read — even an org paying through another
 * acquirer, or running on free credit with no card at all. A customer is now
 * created only by a flow that needs one (ensureOrgStripeCustomer).
 *
 * Lost-race readers refetch and return the existing row with no side effects.
 */
export async function findOrCreateAccount(
  orgId: string,
  userId: string
) {
  const [existing] = await db
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);

  if (existing) return existing;

  const personId = personIdOrNull(userId);

  const created = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(billingAccounts)
      .values({ orgId })
      .onConflictDoNothing()
      .returning();
    if (!inserted) return null;

    // "We match your first $100" (lib/free-credit-offer): a new org's up-front gift
    // is its org-creation bonus, never the per-person welcome, and a person whose
    // welcome lives elsewhere does NOT zero this org's offer.
    if (inserted.freeCreditOffer === MATCH_FREE_CREDIT_OFFER) {
      return { account: inserted, welcomeHere: false, match: true };
    }

    if (!personId) return { account: inserted, welcomeHere: true };

    const claim = await claimWelcomeForPerson(tx, personId, orgId);
    if (claim.kind === "this_org") return { account: inserted, welcomeHere: true };

    await withdrawFreeCreditOffer(tx, orgId);
    const [withdrawn] = await tx
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);
    console.log(
      `[billing-service] org ${orgId}: person ${personId} already received the welcome on org ${claim.welcomeOrgId} — no welcome here, free-credit offer 0`
    );
    return { account: withdrawn, welcomeHere: false };
  });

  if (!created) {
    const [refetched] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);
    return refetched;
  }

  if ("match" in created && created.match) {
    // The $30 up-front gift, whatever path created the org. Idempotent: an org that
    // already got it (the dashboard's creation-bonus call, the trial seed) gets
    // nothing more — one (org, org_creation_bonus) row, ever.
    await grantOrgCreationBonus(orgId);
    return created.account;
  }

  // No Stripe customer here: creating a billing account (and every read, grant
  // or setting that triggers it) never creates one. A customer is created only
  // by a flow that actually deals with Stripe — see ensureOrgStripeCustomer.

  if (!personId) {
    console.warn(
      `[billing-service] org ${orgId} created by a caller with no person (x-user-id ${userId}) — welcome granted per org, cannot be checked against a person`
    );
  }

  // An org seeded for the unauthenticated trial gets its welcome at SIGNUP, as the
  // REMAINDER (welcome − seeded) — see lib/trial-seed.ts. Normally the seed created
  // the account, so this branch is not reached for one; the check closes the race
  // where a first spend and the seed arrive together, in the only safe direction
  // (never grant a full welcome on top of a seed).
  if (created.welcomeHere && !(await hasTrialSeed(orgId))) {
    try {
      await redeemPromoCode(orgId, userId, WELCOME_PROMO_CODE);
    } catch (err) {
      if (!(err instanceof PromoAlreadyRedeemedError)) throw err;
    }
  }

  return created.account;
}

/**
 * The org's Stripe customer, CREATED the first time a flow that deals with Stripe
 * runs (a Stripe checkout, a Stripe card setup) — and ONLY then.
 *
 * Nothing else creates one: not creating the billing account, not a balance read,
 * not a free-credit grant, not setting the payment mode, not declaring the
 * acquirer. Several paths write the billing row with no customer (the trial seed,
 * the promise pre-creates, and every account since 2026-09-27), so the flows that
 * genuinely NEED a customer ask for one here: read first, and only when none
 * exists issue stripe-service's idempotent `POST /v1/customers` (1:1
 * org<->customer is enforced there, so a race or a retry returns the same one).
 *
 * An org whose acquirer is NOT Stripe never gets one: its card and its checkout
 * live on its own acquirer's customer (stripe-service ignores the Stripe customer
 * for it), so a Stripe customer would be noise carrying a stranger's email.
 * Returns null for such an org. The acquirer is asked of stripe-service, which
 * owns the pin; `LEGACY_PM_GATE_ACQUIRER` names the one acquirer whose customer
 * object this function exists to create.
 *
 * Called only from routes that carry a real end user (`requireOrgHeaders`), so a
 * customer is never minted for an org merely because something READ it.
 *
 * Fail loud: an unreadable acquirer, or a create that yields no readable
 * customer, throws.
 */
export async function ensureOrgStripeCustomer(
  identity: IdentityHeaders
): Promise<StripeCustomer | null> {
  const existing = await getCustomerByOrgOrNull(identity);
  if (existing) return existing;

  const orgId = identity["x-org-id"];
  const acquirer = await getOrgAcquirer(orgId);
  if (acquirer !== LEGACY_PM_GATE_ACQUIRER) {
    console.log(
      `[billing-service] org ${orgId} pays through ${acquirer} — no Stripe customer created`
    );
    return null;
  }

  await ensureCustomer(identity);
  const created = await getCustomerByOrgOrNull(identity);
  if (!created) {
    throw new Error(`stripe-service created no customer for org ${orgId}`);
  }
  return created;
}
