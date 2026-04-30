-- Rename credit_provisions -> credit_ledger
ALTER TABLE "credit_provisions" RENAME TO "credit_ledger";--> statement-breakpoint

-- Add source column (defaults to 'provision' for existing rows)
ALTER TABLE "credit_ledger" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'provision';--> statement-breakpoint

-- Add stripe_balance_txn_id column
ALTER TABLE "credit_ledger" ADD COLUMN IF NOT EXISTS "stripe_balance_txn_id" text;--> statement-breakpoint

-- Add promo_code_id column (FK to local_promo_codes)
ALTER TABLE "credit_ledger" ADD COLUMN IF NOT EXISTS "promo_code_id" uuid REFERENCES "local_promo_codes"("id");--> statement-breakpoint

-- Add source index
CREATE INDEX IF NOT EXISTS "idx_credit_ledger_source" ON "credit_ledger" USING btree ("source");--> statement-breakpoint

-- Rename old indexes
ALTER INDEX IF EXISTS "idx_credit_provisions_org_id" RENAME TO "idx_credit_ledger_org_id";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_credit_provisions_status" RENAME TO "idx_credit_ledger_status";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_credit_provisions_brand_ids" RENAME TO "idx_credit_ledger_brand_ids";--> statement-breakpoint

-- Partial unique index for promo anti-double-redemption
CREATE UNIQUE INDEX IF NOT EXISTS "idx_credit_ledger_promo_org" ON "credit_ledger" ("promo_code_id", "org_id") WHERE source = 'promo';--> statement-breakpoint

-- Rename promo_codes -> local_promo_codes
ALTER TABLE "promo_codes" RENAME TO "local_promo_codes";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_promo_codes_code" RENAME TO "idx_local_promo_codes_code";--> statement-breakpoint

-- Drop promo_redemptions table (data migrated to credit_ledger with source='promo')
-- Migrate existing promo_redemptions to credit_ledger before dropping
INSERT INTO "credit_ledger" (org_id, user_id, type, amount_cents, status, source, promo_code_id, description, created_at, updated_at)
SELECT
  pr.org_id,
  pr.user_id,
  'credit',
  pc.amount_cents,
  'confirmed',
  'promo',
  pr.promo_code_id,
  'Promo credit: ' || pc.code || ' ($' || (pc.amount_cents / 100.0)::text || ')',
  pr.created_at,
  pr.created_at
FROM "promo_redemptions" pr
JOIN "local_promo_codes" pc ON pc.id = pr.promo_code_id
ON CONFLICT DO NOTHING;--> statement-breakpoint

DROP TABLE IF EXISTS "promo_redemptions";
