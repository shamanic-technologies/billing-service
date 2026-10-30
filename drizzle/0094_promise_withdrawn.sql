-- DISCOUNT-NO-MATCH-1030 (owner 2026-10-30): « le 50% de discount et le 100 match 100
-- ne sont pas cumulables ». A welcome promise withdrawn because the org holds a usage
-- discount keeps a trace of what it was and why it went (lib/discount-match-exclusion).
-- Columns only, no row touched: the withdrawal itself is written by code. Idempotent.
ALTER TABLE "free_credit_promises" ADD COLUMN IF NOT EXISTS "withdrawn_at" timestamp with time zone;
ALTER TABLE "free_credit_promises" ADD COLUMN IF NOT EXISTS "withdrawn_reason" text;
ALTER TABLE "free_credit_promises" ADD COLUMN IF NOT EXISTS "withdrawn_amount_cents" integer;
