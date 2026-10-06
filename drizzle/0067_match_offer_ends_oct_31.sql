-- "We match your first $100" runs until October 31, 2026 (owner 2026-10-06). An
-- account created at or after 2026-11-01 00:00 UTC gets no free-credit offer: its
-- entitlement and trigger default to 0, so the welcome-completion remainder is 0 and
-- nothing is ever granted. The org-creation bonus is gated on the same instant in
-- code (lib/free-credit-offer matchUpFrontAllowed).
--
-- A date-aware column DEFAULT: evaluated at INSERT, so no row is written now, every
-- existing account keeps its frozen figures, and an account created before the date
-- keeps its $100 match forever (including a +$70 earned after it). Idempotent.
--
-- Reverse: SET DEFAULT 10000 on both columns.

ALTER TABLE "billing_accounts"
  ALTER COLUMN "free_credit_entitlement_cents"
  SET DEFAULT (CASE WHEN now() < '2026-11-01 00:00:00+00'::timestamptz THEN 10000 ELSE 0 END);

ALTER TABLE "billing_accounts"
  ALTER COLUMN "free_credit_paid_trigger_cents"
  SET DEFAULT (CASE WHEN now() < '2026-11-01 00:00:00+00'::timestamptz THEN 10000 ELSE 0 END);
