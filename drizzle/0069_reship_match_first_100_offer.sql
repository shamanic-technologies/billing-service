-- Owner, final (2026-10-06): 100% prepaid, and "We match your first $100" is back.
-- Re-applies the database side of 0066 + 0067 that 0068 undid, for every account
-- created from now on. Same shape as 0066: the column is ADDED with 'legacy' (every
-- existing account, including those created while the match was off, stays legacy),
-- THEN its default is aimed at new accounts. Idempotent on re-apply.
--
-- Reverse: 0068.

ALTER TABLE "billing_accounts"
  ADD COLUMN IF NOT EXISTS "free_credit_offer" text NOT NULL DEFAULT 'legacy';

ALTER TABLE "billing_accounts"
  ALTER COLUMN "free_credit_offer" SET DEFAULT 'match_100';

ALTER TABLE "billing_accounts"
  ALTER COLUMN "free_credit_entitlement_cents"
  SET DEFAULT (CASE WHEN now() < '2026-11-01 00:00:00+00'::timestamptz THEN 10000 ELSE 0 END);

ALTER TABLE "billing_accounts"
  ALTER COLUMN "free_credit_paid_trigger_cents"
  SET DEFAULT (CASE WHEN now() < '2026-11-01 00:00:00+00'::timestamptz THEN 10000 ELSE 0 END);

UPDATE "local_promo_codes" SET "amount_cents" = 3000 WHERE "code" = 'org_creation_bonus';
