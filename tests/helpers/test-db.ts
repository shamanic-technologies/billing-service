import { db, sql } from "../../src/db/index.js";
import { billingAccounts, creditProvisions } from "../../src/db/schema.js";

export async function cleanTestData() {
  await db.delete(creditProvisions);
  await db.delete(billingAccounts);
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

export async function closeDb() {
  await sql.end();
}
