-- Stripe-aligned vocabulary refactor (v3).
-- Renames billing_accounts columns, signs amount_cents on the ledger
-- (negative = credit, positive = debit), migrates status + type values to
-- Stripe PaymentIntent / Customer Balance Transaction semantics, renames
-- the `transactions` table to `customer_balance_transactions`, and renames
-- the pre-#104 charge archive.
--
-- See CLAUDE.md "Vocabulary (Stripe-aligned)" section for the full mapping.
--
-- Idempotency: this migration is recorded by drizzle's __drizzle_migrations
-- table and will not re-run on already-migrated DBs. Index renames use
-- IF EXISTS for safety; data transforms are guarded by structural checks
-- where re-running would corrupt data.

-- Phase 1: rename billing_accounts columns
ALTER TABLE "billing_accounts" RENAME COLUMN "credit_balance_cents" TO "balance_cents";--> statement-breakpoint
ALTER TABLE "billing_accounts" RENAME COLUMN "reload_amount_cents" TO "topup_amount_cents";--> statement-breakpoint
ALTER TABLE "billing_accounts" RENAME COLUMN "reload_threshold_cents" TO "topup_threshold_cents";--> statement-breakpoint

-- Phase 2: sign amount_cents on transactions. Pre-v3 all amount_cents are stored
-- positive with direction encoded in the `type` column. Post-v3, sign encodes
-- direction. Credits become negative; debits (charge/usage_applied) stay positive.
UPDATE "transactions"
  SET "amount_cents" = -"amount_cents"
  WHERE "type" = 'credit';--> statement-breakpoint

-- Phase 3: migrate status values to Stripe PaymentIntent semantics
UPDATE "transactions" SET "status" = 'requires_capture' WHERE "status" = 'pending';--> statement-breakpoint
UPDATE "transactions" SET "status" = 'succeeded' WHERE "status" = 'confirmed';--> statement-breakpoint
UPDATE "transactions" SET "status" = 'canceled' WHERE "status" = 'cancelled';--> statement-breakpoint

-- Phase 4: drop the direction `type` column (sign of amount_cents encodes it now)
ALTER TABLE "transactions" DROP COLUMN "type";--> statement-breakpoint

-- Phase 5: rename source → type to match Stripe CBT vocabulary
ALTER TABLE "transactions" RENAME COLUMN "source" TO "type";--> statement-breakpoint

-- Phase 6: rename type values to Stripe-aligned names
UPDATE "transactions" SET "type" = 'payment' WHERE "type" = 'reload';--> statement-breakpoint
UPDATE "transactions" SET "type" = 'gift' WHERE "type" = 'welcome';--> statement-breakpoint
-- 'promo', 'refund' stay; 'charge' rows are archived post-#107 but rename any stragglers.
UPDATE "transactions" SET "type" = 'usage_applied' WHERE "type" = 'charge';--> statement-breakpoint

-- Phase 7: rename stripe_balance_txn_id → stripe_balance_transaction_id (full Stripe name)
ALTER TABLE "transactions" RENAME COLUMN "stripe_balance_txn_id" TO "stripe_balance_transaction_id";--> statement-breakpoint

-- Phase 8: rename indexes
ALTER INDEX IF EXISTS "idx_transactions_org_id" RENAME TO "idx_cbt_org_id";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_transactions_status" RENAME TO "idx_cbt_status";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_transactions_source" RENAME TO "idx_cbt_type";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_transactions_cost_id" RENAME TO "idx_cbt_cost_id";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_transactions_brand_ids" RENAME TO "idx_cbt_brand_ids";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_transactions_promo_org" RENAME TO "idx_cbt_promo_org";--> statement-breakpoint

-- Phase 9: recreate partial unique index (predicate changed: source→type, 'reload'→'payment')
DROP INDEX IF EXISTS "idx_transactions_reload_pi";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_cbt_payment_pi";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_cbt_payment_pi" ON "transactions" ("org_id", "stripe_payment_intent_id")
  WHERE "type" = 'payment' AND "stripe_payment_intent_id" IS NOT NULL;--> statement-breakpoint

-- Phase 10: rename table
ALTER TABLE "transactions" RENAME TO "customer_balance_transactions";--> statement-breakpoint

-- Phase 11: rename archive table (if exists)
ALTER TABLE IF EXISTS "transactions_archive_pre104_charges" RENAME TO "cbt_archive_pre104_usage";--> statement-breakpoint

-- Phase 12: invariant — only canonical v3 type values remain
DO $$
DECLARE bad_count int;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM "customer_balance_transactions"
  WHERE "type" NOT IN ('payment', 'gift', 'promo', 'refund', 'usage_applied');
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'v3 migration left % rows with non-canonical type', bad_count;
  END IF;
END $$;--> statement-breakpoint

-- Phase 13: invariant — only Stripe-aligned status values
DO $$
DECLARE bad_count int;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM "customer_balance_transactions"
  WHERE "status" NOT IN ('requires_capture', 'succeeded', 'canceled');
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'v3 migration left % rows with non-canonical status', bad_count;
  END IF;
END $$;
