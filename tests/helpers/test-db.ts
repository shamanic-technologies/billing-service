import { db, sql } from "../../src/db/index.js";
import {
  billingAccounts,
  creditLedger,
  localPromoCodes,
} from "../../src/db/schema.js";

export async function cleanTestData() {
  await db.delete(creditLedger);
  await db.delete(billingAccounts);
  await db.delete(localPromoCodes);
}

export async function insertTestAccount(data: {
  orgId: string;
  stripeCustomerId?: string;
  creditBalanceCents?: number;
  reloadAmountCents?: number;
  reloadThresholdCents?: number;
  stripePaymentMethodId?: string;
}) {
  const [account] = await db
    .insert(billingAccounts)
    .values({
      orgId: data.orgId,
      stripeCustomerId: data.stripeCustomerId ?? null,
      creditBalanceCents: data.creditBalanceCents ?? 200,
      reloadAmountCents: data.reloadAmountCents ?? null,
      reloadThresholdCents: data.reloadThresholdCents ?? 200,
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
