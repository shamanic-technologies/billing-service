-- OFFER-RESET-1029 (owner 2026-10-29): every account created from now on is on the
-- 'prepaid_at_cost' offer: prepaid, no free credit (no $100 match, no welcome
-- completion), a $5 onboarding advance (written by code, not here).
--   « on arrete le $100 de free credit et les $ gratuits de referral. Bien sur on
--     grandfather les clients actuels. »
-- DEFAULTS ONLY: no existing row is touched, so every existing account keeps its
-- offer, its figures, its payment mode. Idempotent by nature.
--
-- Reverse: SET DEFAULT 'match_100' / 10000 / 10000 / 'postpaid' / true.

ALTER TABLE "billing_accounts" ALTER COLUMN "free_credit_offer" SET DEFAULT 'prepaid_at_cost';
ALTER TABLE "billing_accounts" ALTER COLUMN "free_credit_entitlement_cents" SET DEFAULT 0;
ALTER TABLE "billing_accounts" ALTER COLUMN "free_credit_paid_trigger_cents" SET DEFAULT 0;
ALTER TABLE "billing_accounts" ALTER COLUMN "payment_mode" SET DEFAULT 'prepaid';
ALTER TABLE "billing_accounts" ALTER COLUMN "welcome_completion_eligible" SET DEFAULT false;
