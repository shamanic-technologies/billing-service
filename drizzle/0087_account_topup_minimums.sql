-- Per-account top-up minimums (owner 2026-10-13: « tu me soules avec tes limites
-- hardcodées »). Staff can lower (or raise) the smallest top-up and the smallest
-- auto-reload threshold of ONE org. NULL = the offer's default (match_100: $100 /
-- $5; every other offer: none), which is every existing row: no account changes.
--
-- Writes no rows. Idempotent. Reverse:
--   ALTER TABLE billing_accounts DROP COLUMN topup_minimum_cents,
--     DROP COLUMN reload_threshold_minimum_cents, DROP COLUMN topup_minimums_set_by,
--     DROP COLUMN topup_minimums_set_at;
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "topup_minimum_cents" integer;
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "reload_threshold_minimum_cents" integer;
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "topup_minimums_set_by" text;
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "topup_minimums_set_at" timestamp with time zone;
DO $$ BEGIN
  ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_topup_minimums_non_negative"
    CHECK (("topup_minimum_cents" IS NULL OR "topup_minimum_cents" >= 0)
       AND ("reload_threshold_minimum_cents" IS NULL OR "reload_threshold_minimum_cents" >= 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
