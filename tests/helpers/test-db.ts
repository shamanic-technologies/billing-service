import { db, sql } from "../../src/db/index.js";
import { billingAccounts } from "../../src/db/schema.js";

export async function cleanTestData() {
  await db.delete(billingAccounts);
}

export async function insertTestAccount(data: {
  orgId: string;
  appId?: string;
  stripeCustomerId?: string;
  billingMode?: string;
  creditBalanceCents?: number;
  reloadAmountCents?: number;
  reloadThresholdCents?: number;
  stripePaymentMethodId?: string;
}) {
  const [account] = await db
    .insert(billingAccounts)
    .values({
      orgId: data.orgId,
      appId: data.appId ?? "testapp",
      stripeCustomerId: data.stripeCustomerId ?? null,
      billingMode: data.billingMode ?? "trial",
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
