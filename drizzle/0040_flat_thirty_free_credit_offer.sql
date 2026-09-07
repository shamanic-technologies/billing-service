-- Re-price the free-credit offer to a FLAT $30, granted in full at signup.
--
-- The offer was a MATCH: $5 landed at signup and the remaining $395 landed only once
-- the org's cumulative succeeded payments reached $400. The product owner has replaced
-- it with a flat $30 that is given up front, unconditionally, with nothing to earn:
--
--   credit granted = $30, always, at signup (the `welcome` promo row, re-priced to
--                    3000 at runtime by the dashboard's PATCH /v1/promo-codes/welcome)
--   cash charged   = max($0, daily_budget - $30) at the onboarding checkout
--
-- So a $30/day signup pays nothing and starts with $30 of balance; a $50/day signup
-- pays $20 and starts with $50. Both received exactly $30 — never $60, never $0.
--
-- ONE statement per column, and it is the SAME one-line re-price migration 0032
-- designed for: move the column DEFAULT, touch no row. Existing accounts already hold
-- their own frozen figures, so the $25 grandfathered cohort and the $400 cohort are
-- untouched by construction — no cutoff date, no backfill, nothing to re-derive. There
-- is deliberately NO `ADD COLUMN` half here: 0032 created the columns and backfilled
-- them once; repeating that would be the only way this migration could re-price
-- somebody, so it is absent.
--
-- Idempotent: SET DEFAULT is idempotent by nature, and since no row is written a
-- re-apply changes nothing at all.
--
-- Reverse (restores the $400 offer for FUTURE accounts only, same as above):
--   ALTER TABLE "billing_accounts"
--     ALTER COLUMN "free_credit_entitlement_cents" SET DEFAULT 40000;
--   ALTER TABLE "billing_accounts"
--     ALTER COLUMN "free_credit_paid_trigger_cents" SET DEFAULT 40000;

ALTER TABLE "billing_accounts"
  ALTER COLUMN "free_credit_entitlement_cents" SET DEFAULT 3000;

ALTER TABLE "billing_accounts"
  ALTER COLUMN "free_credit_paid_trigger_cents" SET DEFAULT 3000;
