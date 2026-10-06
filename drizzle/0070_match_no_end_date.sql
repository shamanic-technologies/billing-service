-- "We match your first $100" has NO end date (owner 2026-10-06: « ongoing pour le
-- moment »). Undoes the date-aware DEFAULT of 0067/0069: every new account gets the
-- $100 / $100 figures whenever it is created. No row is written. Idempotent.

ALTER TABLE "billing_accounts"
  ALTER COLUMN "free_credit_entitlement_cents" SET DEFAULT 10000;

ALTER TABLE "billing_accounts"
  ALTER COLUMN "free_credit_paid_trigger_cents" SET DEFAULT 10000;
