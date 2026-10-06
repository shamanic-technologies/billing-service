-- Owner reversal (2026-10-06): "We match your first $100" is cancelled before any
-- org received it. New orgs go back to exactly what they got before 0066: the flat
-- $30/$30 offer columns, the per-person welcome, the $5 org-creation bonus, no
-- top-up minimums. The code of 0066/0067 is reverted; these statements undo their
-- database side.
--
-- Measured in prod before this ran: 0 accounts with free_credit_offer = 'match_100'
-- (all 214 'legacy'), so dropping the column loses nothing. Re-apply: every
-- statement is idempotent.

ALTER TABLE "billing_accounts"
  ALTER COLUMN "free_credit_entitlement_cents" SET DEFAULT 3000;

ALTER TABLE "billing_accounts"
  ALTER COLUMN "free_credit_paid_trigger_cents" SET DEFAULT 3000;

ALTER TABLE "billing_accounts" DROP COLUMN IF EXISTS "free_credit_offer";

UPDATE "local_promo_codes" SET "amount_cents" = 500 WHERE "code" = 'org_creation_bonus';
