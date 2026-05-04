import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { creditLedger } from "../db/schema.js";
import { createBalanceTransaction } from "./stripe.js";

/**
 * Fire-and-forget a Stripe customer balance transaction, then update the ledger
 * entry with the resulting transaction ID. Errors are logged but never thrown.
 */
export function fireAndForgetBalanceTxn(
  orgId: string,
  userId: string,
  customerId: string,
  amountCents: number,
  description: string,
  ledgerEntryId: string,
  wfHeaders?: Record<string, string>
): void {
  // Note: do NOT pass `ledgerEntryId` as `idempotencyKey` here. Multiple distinct
  // Stripe operations (initial debit, provision adjustment, cancel refund) target the
  // same ledger row id with different params; reusing the key would trigger
  // StripeIdempotencyError. Recovery via reconcile() Check 3 owns idempotency keying.
  createBalanceTransaction(
    orgId,
    userId,
    customerId,
    amountCents,
    description,
    undefined,
    wfHeaders
  )
    .then((txn) => {
      db.update(creditLedger)
        .set({ stripeBalanceTxnId: txn.id, updatedAt: new Date() })
        .where(eq(creditLedger.id, ledgerEntryId))
        .then(() => {})
        .catch(() => {});
    })
    .catch((err) => {
      console.error(
        `[billing-service] Stripe balance txn failed (async) for ledger ${ledgerEntryId}:`,
        err
      );
    });
}
