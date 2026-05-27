import { eq, notInArray } from "drizzle-orm";
import { db, sql } from "../../src/db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  WELCOME_PROMO_CODE,
  INVITE_REWARD_CODE,
  INVITE_WELCOME_CODE,
} from "../../src/db/schema.js";

const SEEDED_PROMO_CODES = [
  WELCOME_PROMO_CODE,
  INVITE_REWARD_CODE,
  INVITE_WELCOME_CODE,
];

export async function cleanTestData() {
  await db.delete(localPromos);
  await db.delete(billingAccounts);
  // Keep seeded codes (welcome + invite_reward + invite_welcome); remove any
  // test-created codes.
  await db
    .delete(localPromoCodes)
    .where(notInArray(localPromoCodes.code, SEEDED_PROMO_CODES));
}

export async function insertTestAccount(data: {
  orgId: string;
  topupAmountCents?: number;
  topupThresholdCents?: number;
}) {
  const [account] = await db
    .insert(billingAccounts)
    .values({
      orgId: data.orgId,
      topupAmountCents: data.topupAmountCents ?? null,
      topupThresholdCents: data.topupThresholdCents ?? 200,
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

export async function closeDb() {
  await sql.end();
}
