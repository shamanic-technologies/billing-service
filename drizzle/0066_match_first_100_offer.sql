-- "We match your first $100" (owner 2026-10-06): the free-credit offer for every NEW
-- organization. $30 lands at creation, the $70 remainder once the org has PAID $100.
--
-- Same shape as 0032: ADD the cohort column with the value every EXISTING account
-- must keep ('legacy'), THEN aim the default at new accounts ('match_100'). On a
-- re-apply `ADD COLUMN IF NOT EXISTS` is a no-op, so an existing match_100 account can
-- never be re-stamped legacy, and no legacy account can become match_100.
--
-- The two figure defaults move to $100 / $100 exactly like 0040 moved them to $30:
-- no row is written, every existing account keeps its own frozen figures.
--
-- The org-creation bonus code row is re-priced to $30: for a match_100 org it IS the
-- up-front part of the offer. It is granted once per org, at creation only, so no
-- existing org receives anything from this.
--
-- Reverse (new accounts only; existing rows untouched):
--   ALTER TABLE "billing_accounts" ALTER COLUMN "free_credit_offer" SET DEFAULT 'legacy';
--   ALTER TABLE "billing_accounts" ALTER COLUMN "free_credit_entitlement_cents" SET DEFAULT 3000;
--   ALTER TABLE "billing_accounts" ALTER COLUMN "free_credit_paid_trigger_cents" SET DEFAULT 3000;
--   UPDATE "local_promo_codes" SET "amount_cents" = 500 WHERE "code" = 'org_creation_bonus';

ALTER TABLE "billing_accounts"
  ADD COLUMN IF NOT EXISTS "free_credit_offer" text NOT NULL DEFAULT 'legacy';

ALTER TABLE "billing_accounts"
  ALTER COLUMN "free_credit_offer" SET DEFAULT 'match_100';

ALTER TABLE "billing_accounts"
  ALTER COLUMN "free_credit_entitlement_cents" SET DEFAULT 10000;

ALTER TABLE "billing_accounts"
  ALTER COLUMN "free_credit_paid_trigger_cents" SET DEFAULT 10000;

UPDATE "local_promo_codes" SET "amount_cents" = 3000 WHERE "code" = 'org_creation_bonus';
