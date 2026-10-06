import { and, eq, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  PLATFORM_USER_ID,
  TRIAL_SEED_CODE,
  WELCOME_PROMO_CODE,
} from "../db/schema.js";
import {
  claimWelcomeForPerson,
  withdrawFreeCreditOffer,
} from "./welcome-recipient.js";
import { getSubscriptionTrialGrantCents } from "./subscription.js";
import { getOrgFreeCreditOffer } from "./free-credit-offer.js";
import { grantOrgCreationBonus, sumEntitlementGrantsForOrg } from "./promos.js";
import { MATCH_FREE_CREDIT_OFFER } from "../db/schema.js";

/**
 * Trial seed — free credit for an org that has NOT signed up yet, and the settlement
 * that lands its TOTAL free credit on exactly the welcome amount once it does.
 *
 * Two rules, and the second one is the whole design:
 *
 *   1. The seed is its own ledger key (`trial_seed`), never the welcome gift. It
 *      exists so the account can do its work while a visitor walks the product
 *      unauthenticated; it is not an offer and no customer-facing figure states it.
 *
 *   2. The seed IS the whole live welcome amount (owner decision 2026-09-28): the
 *      signed-out walk (company read, competitors, segments, companies, decision
 *      makers, one written email) provisions worst-case HOLDS before it spends, and
 *      any slice smaller than the offer the dashboard already promises ran short
 *      mid-walk. At signup the org receives the REMAINDER — `welcome − already
 *      seeded` — which is 0 for an org seeded under this rule, so its total stays
 *      exactly the welcome amount. Orgs seeded under the earlier $5 / $12 slices
 *      still receive their own remainder. Nothing is clawed back.
 *
 * Both amounts are derived from the LIVE `welcome` promo-code row (the same row
 * `PATCH /internal/promo-codes/welcome` re-prices), so re-pricing the welcome offer
 * moves both sides at once and cannot leave them summing to the wrong number. There
 * is deliberately no independently-chosen seed figure to keep in step.
 */

export class TrialSeedWelcomeAlreadyGrantedError extends Error {
  constructor(orgId: string) {
    super(
      `org ${orgId} already holds the welcome gift — seeding it would exceed the welcome amount`
    );
  }
}

export class TrialSeedPromoCodeMissingError extends Error {
  constructor(code: string) {
    super(`trial-seed promo code seed missing: ${code} (run migration 0046)`);
  }
}

/**
 * What to seed an org with: the whole live welcome amount, never negative. THE one
 * place a seed amount is decided — it is what keeps the signup remainder
 * (`welcome − seeded`) at exactly 0 for a freshly seeded org, at any welcome price.
 */
export function resolveTrialSeedAmountCents(welcomeAmountCents: number): number {
  return Math.max(0, welcomeAmountCents);
}

async function requirePromoCode(code: string) {
  const [row] = await db
    .select()
    .from(localPromoCodes)
    .where(eq(localPromoCodes.code, code))
    .limit(1);
  if (!row) throw new TrialSeedPromoCodeMissingError(code);
  return row;
}

/** Sum of this org's trial-seed grants, in cents (0 when it was never seeded). */
export async function sumTrialSeedGrantsForOrg(orgId: string): Promise<number> {
  const [row] = await db
    .select({
      total: rawSql<string>`COALESCE(SUM(${localPromos.amountCents}), 0)::text`,
    })
    .from(localPromos)
    .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
    .where(
      and(eq(localPromos.orgId, orgId), eq(localPromoCodes.code, TRIAL_SEED_CODE))
    );
  return Math.round(Number(row?.total ?? "0"));
}

/** True when this org carries a trial seed — i.e. it came into being unauthenticated. */
export async function hasTrialSeed(orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: localPromos.id })
    .from(localPromos)
    .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
    .where(
      and(eq(localPromos.orgId, orgId), eq(localPromoCodes.code, TRIAL_SEED_CODE))
    )
    .limit(1);
  return !!row;
}

async function hasWelcomeGrant(orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: localPromos.id })
    .from(localPromos)
    .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
    .where(
      and(eq(localPromos.orgId, orgId), eq(localPromoCodes.code, WELCOME_PROMO_CODE))
    )
    .limit(1);
  return !!row;
}

export interface TrialSeedResult {
  orgId: string;
  seededCents: number;
  alreadySeeded: boolean;
}

/**
 * Put the trial seed on an org that has not signed up.
 *
 * Creates the billing account itself (ON CONFLICT DO NOTHING) rather than going
 * through `findOrCreateAccount`, which redeems the welcome gift on a fresh create —
 * the one thing this path must not do.
 *
 * Idempotent on (org, trial_seed) through the partial unique index, so seeding twice
 * does not double the seed.
 *
 * Fails loud (never silently seeds on top) when the org already holds the welcome
 * gift: that org has signed up, or spent before it was seeded, and adding a seed to it
 * is exactly the "welcome amount PLUS the seed" outcome this exists to prevent.
 */
export async function seedTrialCredit(orgId: string): Promise<TrialSeedResult> {
  // "We match your first $100": a NEW org's up-front free credit is its ONE
  // org-creation bonus ($30), whichever path asks first — so the anonymous walk gets
  // the same $30 a dashboard-created org gets, and a racing first billing touch can
  // never add a second up-front gift (same unique row). No `trial_seed` row.
  // The account first, so its offer is the one the DB default gives a new org.
  await db.insert(billingAccounts).values({ orgId }).onConflictDoNothing();
  if ((await getOrgFreeCreditOffer(orgId)) === MATCH_FREE_CREDIT_OFFER) {
    const bonus = await grantOrgCreationBonus(orgId);
    return { orgId, seededCents: bonus.grantedCents, alreadySeeded: bonus.alreadyGranted };
  }

  const welcome = await requirePromoCode(WELCOME_PROMO_CODE);
  const seedCode = await requirePromoCode(TRIAL_SEED_CODE);

  if (await hasWelcomeGrant(orgId)) {
    throw new TrialSeedWelcomeAlreadyGrantedError(orgId);
  }

  const amountCents = resolveTrialSeedAmountCents(welcome.amountCents);

  return db.transaction(async (tx) => {
    await tx.insert(billingAccounts).values({ orgId }).onConflictDoNothing();

    const inserted = await tx
      .insert(localPromos)
      .values({
        orgId,
        userId: PLATFORM_USER_ID,
        amountCents: String(amountCents),
        promoCodeId: seedCode.id,
        // Internal wording: this line is staff/ledger-facing. The visitor is never
        // shown the seed by any name.
        description: `Trial seed: $${(amountCents / 100).toFixed(2)}`,
      })
      .onConflictDoNothing({
        target: [localPromos.orgId, localPromos.promoCodeId],
        where: rawSql`idempotency_key IS NULL`,
      })
      .returning();

    if (inserted.length > 0) {
      return { orgId, seededCents: amountCents, alreadySeeded: false };
    }

    const [existing] = await tx
      .select({ amountCents: localPromos.amountCents })
      .from(localPromos)
      .where(
        and(
          eq(localPromos.orgId, orgId),
          eq(localPromos.promoCodeId, seedCode.id)
        )
      )
      .limit(1);

    return {
      orgId,
      seededCents: Math.round(Number(existing?.amountCents ?? amountCents)),
      alreadySeeded: true,
    };
  });
}

export interface SignupWelcomeResult {
  orgId: string;
  trialSeedCents: number;
  welcomeGrantedCents: number;
  totalFreeCreditCents: number;
  alreadySettled: boolean;
  /**
   * True when the person signing up already received the welcome on ANOTHER org, so
   * this org got none and its own free-credit offer is zero. Its trial seed, if any,
   * is kept (never clawed back).
   */
  welcomeReceivedElsewhere: boolean;
}

/**
 * Land this org's free credit on exactly the welcome amount, at signup — once per
 * PERSON.
 *
 * An org with NO trial seed receives the whole welcome offer, granted under the same
 * `welcome` code, at the same live amount `findOrCreateAccount` would have used. So a
 * caller may run this for every signup.
 *
 * A seeded org receives `welcome − seeded`, which is what makes the total the welcome
 * amount rather than the welcome amount plus the seed. For an org seeded with the
 * whole welcome (the rule since 2026-09-28) that remainder is 0 and nothing is
 * granted — but the person is still bound to this org, so their NEXT org gets no
 * welcome. Orgs seeded under the earlier smaller slices receive their remainder.
 *
 * `personId` is who signed up (lib/welcome-recipient). When that person's welcome
 * already lives on another org, this org gets NO welcome and its offer goes to zero;
 * its seed stays. Without a person (a caller that has not learned to send one) the
 * historical per-org behaviour applies — billing cannot tell whose org it is.
 *
 * Idempotent: the org's welcome row (partial unique on (org, promo_code)) is the
 * marker, so a replay is a no-op and can never grant twice.
 */
export async function settleSignupWelcome(
  orgId: string,
  personId: string | null
): Promise<SignupWelcomeResult> {
  // A match_100 org gets NO welcome at signup and its offer is never zeroed by the
  // person's history: its whole up-front gift is the org-creation bonus (granted here
  // too, idempotently, for an org that reached signup without one).
  // The account first, so its offer is the one the DB default gives a new org.
  await db.insert(billingAccounts).values({ orgId }).onConflictDoNothing();
  if ((await getOrgFreeCreditOffer(orgId)) === MATCH_FREE_CREDIT_OFFER) {
    await grantOrgCreationBonus(orgId);
    return {
      orgId,
      trialSeedCents: await sumTrialSeedGrantsForOrg(orgId),
      welcomeGrantedCents: 0,
      totalFreeCreditCents: Math.round(Number(await sumEntitlementGrantsForOrg(orgId))),
      alreadySettled: true,
      welcomeReceivedElsewhere: false,
    };
  }

  const welcome = await requirePromoCode(WELCOME_PROMO_CODE);
  const trialSeedCents = await sumTrialSeedGrantsForOrg(orgId);

  if (await hasWelcomeGrant(orgId)) {
    return {
      orgId,
      trialSeedCents,
      welcomeGrantedCents: 0,
      totalFreeCreditCents: welcome.amountCents,
      alreadySettled: true,
      welcomeReceivedElsewhere: false,
    };
  }

  // A SUBSCRIPTION org's trial grant already topped its free credit up to the trial
  // amount (lib/subscription), welcome included; a welcome landing after it would
  // put free credit beyond what the owner allows. So its remainder counts the grant.
  const subscriptionTrialCents = (await getSubscriptionTrialGrantCents(orgId)) ?? 0;
  const remainderCents = Math.max(
    0,
    welcome.amountCents - trialSeedCents - subscriptionTrialCents
  );

  const outcome = await db.transaction(async (tx) => {
    await tx.insert(billingAccounts).values({ orgId }).onConflictDoNothing();

    if (personId) {
      const claim = await claimWelcomeForPerson(tx, personId, orgId);
      if (claim.kind === "other_org") {
        await withdrawFreeCreditOffer(tx, orgId);
        return { elsewhere: true as const, inserted: 0 };
      }
    }

    if (remainderCents === 0) return { elsewhere: false as const, inserted: 0 };

    const inserted = await tx
      .insert(localPromos)
      .values({
        orgId,
        userId: personId ?? PLATFORM_USER_ID,
        amountCents: String(remainderCents),
        promoCodeId: welcome.id,
        description: `Trial gift: $${(remainderCents / 100).toFixed(2)}`,
      })
      .onConflictDoNothing({
        target: [localPromos.orgId, localPromos.promoCodeId],
        where: rawSql`idempotency_key IS NULL`,
      })
      .returning();
    return { elsewhere: false as const, inserted: inserted.length };
  });

  if (outcome.elsewhere) {
    return {
      orgId,
      trialSeedCents,
      welcomeGrantedCents: 0,
      totalFreeCreditCents: trialSeedCents,
      alreadySettled: false,
      welcomeReceivedElsewhere: true,
    };
  }

  if (remainderCents === 0) {
    return {
      orgId,
      trialSeedCents,
      welcomeGrantedCents: 0,
      totalFreeCreditCents: trialSeedCents,
      alreadySettled: true,
      welcomeReceivedElsewhere: false,
    };
  }

  return {
    orgId,
    trialSeedCents,
    welcomeGrantedCents: outcome.inserted > 0 ? remainderCents : 0,
    totalFreeCreditCents: trialSeedCents + remainderCents,
    alreadySettled: outcome.inserted === 0,
    welcomeReceivedElsewhere: false,
  };
}
