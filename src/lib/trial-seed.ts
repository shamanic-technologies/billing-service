import { and, eq, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  PLATFORM_USER_ID,
  TRIAL_SEED_CODE,
  TRIAL_SEED_TARGET_CENTS,
  WELCOME_PROMO_CODE,
} from "../db/schema.js";

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
 *   2. At signup the org receives the REMAINDER — `welcome − already seeded` — so its
 *      total is the welcome amount, not the welcome amount PLUS the seed. Nothing is
 *      clawed back: what the visitor already consumed stays consumed, because what is
 *      fixed is the TOTAL, not the remainder.
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
 * What to seed an org with, clamped to the live welcome amount.
 *
 * The clamp is not cosmetic: it makes the signup remainder non-negative BY
 * CONSTRUCTION at any welcome price, including one below the seed target, so the
 * "totals exactly the welcome amount" invariant holds with no special case and no
 * negative grant. THE one place a seed amount is decided.
 */
export function resolveTrialSeedAmountCents(welcomeAmountCents: number): number {
  return Math.min(TRIAL_SEED_TARGET_CENTS, Math.max(0, welcomeAmountCents));
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
 * is exactly the "welcome amount PLUS five dollars" outcome this exists to prevent.
 */
export async function seedTrialCredit(orgId: string): Promise<TrialSeedResult> {
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
}

/**
 * Land this org's free credit on exactly the welcome amount, at signup.
 *
 * An org with NO trial seed is byte-for-byte what it has always been: it receives the
 * whole welcome offer, granted under the same `welcome` code, at the same live amount
 * `findOrCreateAccount` would have used. So a caller may run this for every signup.
 *
 * A seeded org receives `welcome − seeded`, which is what makes the total the welcome
 * amount rather than the welcome amount plus the seed. A remainder of zero (only
 * reachable when the welcome offer is priced at or below the seed) grants nothing —
 * the org already holds exactly the welcome amount, so there is nothing to add.
 *
 * Idempotent: the org's welcome row (partial unique on (org, promo_code)) is the
 * marker, so a replay is a no-op and can never grant twice.
 */
export async function settleSignupWelcome(
  orgId: string,
  userId: string
): Promise<SignupWelcomeResult> {
  const welcome = await requirePromoCode(WELCOME_PROMO_CODE);
  const trialSeedCents = await sumTrialSeedGrantsForOrg(orgId);

  if (await hasWelcomeGrant(orgId)) {
    return {
      orgId,
      trialSeedCents,
      welcomeGrantedCents: 0,
      totalFreeCreditCents: welcome.amountCents,
      alreadySettled: true,
    };
  }

  const remainderCents = Math.max(0, welcome.amountCents - trialSeedCents);

  if (remainderCents === 0) {
    return {
      orgId,
      trialSeedCents,
      welcomeGrantedCents: 0,
      totalFreeCreditCents: trialSeedCents,
      alreadySettled: true,
    };
  }

  const inserted = await db.transaction(async (tx) => {
    await tx.insert(billingAccounts).values({ orgId }).onConflictDoNothing();

    return tx
      .insert(localPromos)
      .values({
        orgId,
        userId,
        amountCents: String(remainderCents),
        promoCodeId: welcome.id,
        description: `Trial gift: $${(remainderCents / 100).toFixed(2)}`,
      })
      .onConflictDoNothing({
        target: [localPromos.orgId, localPromos.promoCodeId],
        where: rawSql`idempotency_key IS NULL`,
      })
      .returning();
  });

  return {
    orgId,
    trialSeedCents,
    welcomeGrantedCents: inserted.length > 0 ? remainderCents : 0,
    totalFreeCreditCents: trialSeedCents + remainderCents,
    alreadySettled: inserted.length === 0,
  };
}
