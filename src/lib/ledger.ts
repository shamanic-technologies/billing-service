import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { transactions } from "../db/schema.js";
import { createBalanceTransaction } from "./stripe.js";
import { stripeCeilDelta } from "./cents.js";

/**
 * Fire-and-forget a Stripe customer balance transaction sized to keep Stripe
 * within ≤1¢ of `ceil(ledger_balance)`. Returns synchronously; errors are
 * logged but never thrown. No-ops when the ceil-cent delta is 0 (the ledger
 * moved sub-cent and Stripe doesn't need a touch).
 *
 * Why ceil-delta:
 *   Stripe's `createBalanceTransaction` only accepts integer cents. We round
 *   our fractional ledger up to integer cents on the Stripe side, so Stripe
 *   always shows ≥ ledger floor. Skipping zero-delta ops avoids spamming
 *   Stripe with no-op calls under fractional batching.
 *
 * The ledger row's `stripeBalanceTxnId` is set ONLY when the API call fires,
 * so audits can tell which rows triggered Stripe state changes.
 */
export function syncStripeCeilDelta(args: {
  orgId: string;
  userId: string;
  customerId: string;
  oldBalance: string;
  newBalance: string;
  description: string;
  ledgerEntryId: string;
  wfHeaders?: Record<string, string>;
}): void {
  const delta = stripeCeilDelta(args.oldBalance, args.newBalance);
  if (delta === 0) return;
  // Note: do NOT pass `ledgerEntryId` as `idempotencyKey` here. Multiple distinct
  // Stripe operations (initial debit, provision adjustment, cancel refund) target the
  // same ledger row id with different params; reusing the key would trigger
  // StripeIdempotencyError. Recovery via reconcile() Check 3 owns idempotency keying.
  createBalanceTransaction(
    args.orgId,
    args.userId,
    args.customerId,
    delta,
    args.description,
    undefined,
    args.wfHeaders
  )
    .then((txn) => {
      db.update(transactions)
        .set({ stripeBalanceTxnId: txn.id, updatedAt: new Date() })
        .where(eq(transactions.id, args.ledgerEntryId))
        .then(() => {})
        .catch(() => {});
    })
    .catch((err) => {
      console.error(
        `[billing-service] Stripe balance txn failed (async) for ledger ${args.ledgerEntryId}:`,
        err
      );
    });
}
