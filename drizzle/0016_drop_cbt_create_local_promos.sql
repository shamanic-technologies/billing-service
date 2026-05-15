-- Strip Stripe SDK from billing-service (post-#111).
-- All Stripe state (customers, payment methods, payment intents, paid balance,
-- webhooks) moves to stripe-service. Billing keeps only:
--   - org ↔ topup config (billing_accounts)
--   - promo code definitions (local_promo_codes)
--   - per-org credit grants (local_promos — gift + promo unified)
--
-- Welcome $2 gift is a regular promo with code='welcome', seeded here.
--
-- Idempotency: standard drizzle migrator does not re-run, but each statement
-- guards against partial-apply replay with IF EXISTS / IF NOT EXISTS / ON CONFLICT.

-- Phase 1: create local_promos before backfill (it references local_promo_codes).
CREATE TABLE IF NOT EXISTS "local_promos" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "amount_cents" numeric(16,10) NOT NULL,
  "promo_code_id" uuid NOT NULL REFERENCES "local_promo_codes"("id"),
  "description" text,
  "brand_ids" text[],
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_local_promos_org_promo" ON "local_promos" ("org_id", "promo_code_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_local_promos_org" ON "local_promos" ("org_id");--> statement-breakpoint

-- Phase 2: seed welcome promo code (idempotent).
INSERT INTO "local_promo_codes" ("code", "amount_cents", "max_redemptions", "expires_at")
VALUES ('welcome', 200, NULL, NULL)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint

-- Phase 3: backfill gift + promo rows from CBT into local_promos.
-- Old gift rows have promo_code_id = NULL → point at welcome.
DO $$
DECLARE welcome_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_balance_transactions') THEN
    SELECT id INTO welcome_id FROM local_promo_codes WHERE code = 'welcome';
    INSERT INTO "local_promos" ("id", "org_id", "user_id", "amount_cents", "promo_code_id", "description", "brand_ids", "created_at")
    SELECT
      cbt.id,
      cbt.org_id,
      cbt.user_id,
      ABS(cbt.amount_cents::numeric),
      COALESCE(cbt.promo_code_id, welcome_id),
      cbt.description,
      cbt.brand_ids,
      cbt.created_at
    FROM "customer_balance_transactions" cbt
    WHERE cbt.type IN ('gift', 'promo') AND cbt.status = 'succeeded'
    ON CONFLICT ("org_id", "promo_code_id") DO NOTHING;
  END IF;
END $$;--> statement-breakpoint

-- Phase 4: drop the Stripe-aligned ledger entirely (Stripe-service owns it now).
DROP TABLE IF EXISTS "customer_balance_transactions";--> statement-breakpoint

-- Phase 5: drop legacy charge archive (pre-#104).
DROP TABLE IF EXISTS "cbt_archive_pre104_usage";--> statement-breakpoint
DROP TABLE IF EXISTS "transactions_archive_pre104_charges";--> statement-breakpoint

-- Phase 6: shrink billing_accounts to topup config only.
ALTER TABLE "billing_accounts" DROP COLUMN IF EXISTS "balance_cents";--> statement-breakpoint
ALTER TABLE "billing_accounts" DROP COLUMN IF EXISTS "stripe_customer_id";--> statement-breakpoint
ALTER TABLE "billing_accounts" DROP COLUMN IF EXISTS "stripe_payment_method_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_billing_accounts_stripe_customer";
