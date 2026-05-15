import { db, sql } from "../../src/db/index.js";
import {
  billingAccounts,
  customerBalanceTransactions,
  localPromoCodes,
} from "../../src/db/schema.js";

export async function cleanTestData() {
  await db.delete(customerBalanceTransactions);
  await db.delete(billingAccounts);
  await db.delete(localPromoCodes);
}

export async function insertTestAccount(data: {
  orgId: string;
  stripeCustomerId?: string | null;
  /** Unsigned positive balance cache value. */
  balanceCents?: number | string;
  topupAmountCents?: number;
  topupThresholdCents?: number;
  stripePaymentMethodId?: string | null;
}) {
  const [account] = await db
    .insert(billingAccounts)
    .values({
      orgId: data.orgId,
      stripeCustomerId: data.stripeCustomerId ?? null,
      balanceCents:
        data.balanceCents != null ? String(data.balanceCents) : "200",
      topupAmountCents: data.topupAmountCents ?? null,
      topupThresholdCents: data.topupThresholdCents ?? 200,
      stripePaymentMethodId: data.stripePaymentMethodId ?? null,
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

export async function closeDb() {
  await sql.end();
}
