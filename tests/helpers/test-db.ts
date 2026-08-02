import { asc, eq, notInArray } from "drizzle-orm";
import { db, sql } from "../../src/db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  creditDepletionEpisodes,
  campaignAuthorizeCosts,
  brandDailyBudgets,
  brandDailyBudgetChanges,
  brandFunnelDailyBudgets,
  orgUsageDiscounts,
  freeCreditPromises,
  WELCOME_PROMO_CODE,
  INVITE_REWARD_CODE,
  INVITE_WELCOME_CODE,
  ADMIN_GRANT_CODE,
  WELCOME_COMPLETION_CODE,
  REFERRAL_REWARD_CODE,
  CURRENT_REFERRAL_PROMISE_AMOUNT_CENTS,
  GRANDFATHERED_FREE_CREDIT_ENTITLEMENT_CENTS,
  GRANDFATHERED_FREE_CREDIT_PAID_TRIGGER_CENTS,
  type CreditDepletionEpisode,
  type CampaignAuthorizeCost,
} from "../../src/db/schema.js";

const SEEDED_PROMO_CODES = [
  WELCOME_PROMO_CODE,
  INVITE_REWARD_CODE,
  INVITE_WELCOME_CODE,
  ADMIN_GRANT_CODE,
  WELCOME_COMPLETION_CODE,
  REFERRAL_REWARD_CODE,
];

export async function cleanTestData() {
  await db.delete(freeCreditPromises);
  await db.delete(creditDepletionEpisodes);
  await db.delete(campaignAuthorizeCosts);
  await db.delete(brandDailyBudgetChanges);
  await db.delete(brandFunnelDailyBudgets);
  await db.delete(brandDailyBudgets);
  await db.delete(orgUsageDiscounts);
  await db.delete(localPromos);
  await db.delete(billingAccounts);
  // Keep the seeded codes; remove any test-created code (and any stale
  // `first_load_match` / `brand_welcome` row a pre-0031 local DB still carries —
  // the removal guard in accounts.test.ts asserts it is gone).
  await db
    .delete(localPromoCodes)
    .where(notInArray(localPromoCodes.code, SEEDED_PROMO_CODES));
  await db
    .insert(localPromoCodes)
    .values({
      code: WELCOME_COMPLETION_CODE,
      amountCents: 0,
      maxRedemptions: null,
      expiresAt: null,
    })
    .onConflictDoUpdate({
      target: localPromoCodes.code,
      set: { amountCents: 0 },
    });
  // referral_reward's amount IS the live figure a new referral promise freezes, so
  // restore it to $500 (a test may have re-priced or removed it).
  await db
    .insert(localPromoCodes)
    .values({
      code: REFERRAL_REWARD_CODE,
      amountCents: CURRENT_REFERRAL_PROMISE_AMOUNT_CENTS,
      maxRedemptions: null,
      expiresAt: null,
    })
    .onConflictDoUpdate({
      target: localPromoCodes.code,
      set: { amountCents: CURRENT_REFERRAL_PROMISE_AMOUNT_CENTS },
    });
}

/** Delete the referral ledger key — exercises the fail-loud referral path. */
export async function removeReferralRewardCode() {
  await db
    .delete(localPromoCodes)
    .where(eq(localPromoCodes.code, REFERRAL_REWARD_CODE));
}

/** Every promise row for an org, cheapest bar first — lets tests assert the ladder. */
export async function listPromises(orgId: string) {
  return db
    .select()
    .from(freeCreditPromises)
    .where(eq(freeCreditPromises.orgId, orgId))
    .orderBy(asc(freeCreditPromises.paidTriggerCents));
}

/** Delete the welcome-completion ledger key — exercises the fail-loud / no-discount path. */
export async function removeWelcomeCompletionCode() {
  await db
    .delete(localPromoCodes)
    .where(eq(localPromoCodes.code, WELCOME_COMPLETION_CODE));
}

/** Insert a depletion episode directly (lets tests back-date started_at). */
export async function insertTestEpisode(data: {
  orgId: string;
  userId: string;
  runId?: string | null;
  campaignId?: string | null;
  startedAt?: Date;
  // Recovery baseline. Defaults to "0" so a test that raises credited recovers;
  // pass null to exercise the pre-0020 lazy-backfill path.
  creditedCentsAtOpen?: string | null;
  t0SentAt?: Date | null;
  followup3dSentAt?: Date | null;
  followup10dSentAt?: Date | null;
  recoveredAt?: Date | null;
}): Promise<CreditDepletionEpisode> {
  const [row] = await db
    .insert(creditDepletionEpisodes)
    .values({
      orgId: data.orgId,
      userId: data.userId,
      runId: data.runId ?? null,
      campaignId: data.campaignId ?? null,
      startedAt: data.startedAt ?? new Date(),
      creditedCentsAtOpen:
        data.creditedCentsAtOpen === undefined
          ? "0.0000000000"
          : data.creditedCentsAtOpen,
      t0SentAt: data.t0SentAt ?? new Date(),
      followup3dSentAt: data.followup3dSentAt ?? null,
      followup10dSentAt: data.followup10dSentAt ?? null,
      recoveredAt: data.recoveredAt ?? null,
    })
    .returning();
  return row;
}

export async function listEpisodes(orgId: string): Promise<CreditDepletionEpisode[]> {
  return db
    .select()
    .from(creditDepletionEpisodes)
    .where(eq(creditDepletionEpisodes.orgId, orgId));
}

/**
 * Insert a billing account fixture.
 *
 * `welcomeCompletionEligible` defaults to FALSE — i.e. an org already excluded from
 * the welcome-completion gift — so paid-topup mocks in unrelated suites never trip
 * the grant and shift their credited totals. Pass `true` to exercise the gift.
 *
 * `createdAt` defaults to now (a post-launch signup, which skips the grandfather
 * check). Pass a pre-WELCOME_COMPLETION_LAUNCH_AT_ISO date to stand in for one of
 * the orgs that existed before the automation launched.
 *
 * The free-credit offer defaults to the GRANDFATHERED $25/$25 — i.e. a pre-0032
 * account — so every suite written before the re-price keeps exercising the exact
 * offer it was written against. Pass CURRENT_FREE_CREDIT_* to stand in for a new
 * signup. To exercise what a REAL signup gets, insert with no offer columns at all
 * (findOrCreateAccount inserts org_id only) so the DB DEFAULT applies.
 */
export async function insertTestAccount(data: {
  orgId: string;
  topupAmountCents?: number;
  topupThresholdCents?: number;
  welcomeCompletionEligible?: boolean;
  createdAt?: Date;
  freeCreditEntitlementCents?: number;
  freeCreditPaidTriggerCents?: number;
}) {
  const [account] = await db
    .insert(billingAccounts)
    .values({
      orgId: data.orgId,
      topupAmountCents: data.topupAmountCents ?? null,
      topupThresholdCents: data.topupThresholdCents ?? 200,
      welcomeCompletionEligible: data.welcomeCompletionEligible ?? false,
      freeCreditEntitlementCents:
        data.freeCreditEntitlementCents ??
        GRANDFATHERED_FREE_CREDIT_ENTITLEMENT_CENTS,
      freeCreditPaidTriggerCents:
        data.freeCreditPaidTriggerCents ??
        GRANDFATHERED_FREE_CREDIT_PAID_TRIGGER_CENTS,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    })
    .returning();
  return account;
}

export async function insertTestPromoCode(data: {
  code: string;
  amountCents: number;
  maxRedemptions?: number | null;
  expiresAt?: Date | null;
}) {
  const [promo] = await db
    .insert(localPromoCodes)
    .values({
      code: data.code,
      amountCents: data.amountCents,
      maxRedemptions: data.maxRedemptions ?? null,
      expiresAt: data.expiresAt ?? null,
    })
    .returning();
  return promo;
}

export async function insertTestPromoGrant(data: {
  orgId: string;
  userId: string;
  amountCents: number | string;
  promoCode: string;
  description?: string;
}) {
  const [code] = await db
    .select()
    .from(localPromoCodes)
    .where(eq(localPromoCodes.code, data.promoCode))
    .limit(1);
  if (!code) throw new Error(`promo code not found: ${data.promoCode}`);
  const [row] = await db
    .insert(localPromos)
    .values({
      orgId: data.orgId,
      userId: data.userId,
      amountCents: String(data.amountCents),
      promoCodeId: code.id,
      description: data.description ?? null,
    })
    .returning();
  return row;
}

export async function getCampaignCost(
  campaignId: string
): Promise<CampaignAuthorizeCost | null> {
  const [row] = await db
    .select()
    .from(campaignAuthorizeCosts)
    .where(eq(campaignAuthorizeCosts.campaignId, campaignId))
    .limit(1);
  return row ?? null;
}

export async function insertTestCampaignCost(data: {
  campaignId: string;
  orgId: string;
  lastAuthorizeRequiredCents: string;
}): Promise<CampaignAuthorizeCost> {
  const [row] = await db
    .insert(campaignAuthorizeCosts)
    .values({
      campaignId: data.campaignId,
      orgId: data.orgId,
      lastAuthorizeRequiredCents: data.lastAuthorizeRequiredCents,
    })
    .returning();
  return row;
}

export async function insertTestUsageDiscount(data: {
  orgId: string;
  discountPct: number;
  setBy?: string | null;
}) {
  const [row] = await db
    .insert(orgUsageDiscounts)
    .values({
      orgId: data.orgId,
      discountPct: data.discountPct,
      setBy: data.setBy ?? null,
    })
    .returning();
  return row;
}

export async function closeDb() {
  await sql.end();
}
