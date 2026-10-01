-- SUBSCRIPTION: a third payment mode. $99/month through a Stripe subscription with a
-- 3-day free trial, card required. Prepaid in nature: every paid invoice is that
-- amount of credit (it arrives as an ordinary succeeded payment, which credited
-- already counts), and the org receives a one-shot $99 trial grant when its trial
-- starts. No credit line, no auto-reload. See lib/subscription.ts.
--
-- Three changes, all additive; no existing row moves:
--   1. the payment_mode CHECK accepts 'subscription' (existing rows keep their value)
--   2. billing_accounts.subscription_checkout_started_at: set when a subscription
--      checkout is opened, cleared once the subscription is observed (or abandoned).
--      It bounds which orgs the hourly settle asks stripe-service about.
--   3. the `subscription_trial` ledger key, seeded at 9900 (the live amount is this
--      row, re-priceable via PATCH /internal/promo-codes/subscription_trial). One-shot
--      per org on the partial unique (org_id, promo_code_id) index.
--
-- Idempotent — safe to re-run. Reverse:
--   ALTER TABLE billing_accounts DROP CONSTRAINT IF EXISTS billing_accounts_payment_mode_check;
--   ALTER TABLE billing_accounts ADD CONSTRAINT billing_accounts_payment_mode_check
--     CHECK (payment_mode IN ('prepaid', 'postpaid'));   -- only once no row is 'subscription'
--   ALTER TABLE billing_accounts DROP COLUMN IF EXISTS subscription_checkout_started_at;
--   DELETE FROM local_promo_codes WHERE code = 'subscription_trial'
--     AND NOT EXISTS (SELECT 1 FROM local_promos p WHERE p.promo_code_id = local_promo_codes.id);
ALTER TABLE "billing_accounts" DROP CONSTRAINT IF EXISTS "billing_accounts_payment_mode_check";
--> statement-breakpoint
ALTER TABLE "billing_accounts"
  ADD CONSTRAINT "billing_accounts_payment_mode_check"
  CHECK ("payment_mode" IN ('prepaid', 'postpaid', 'subscription'));
--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "subscription_checkout_started_at" timestamp with time zone;
--> statement-breakpoint
INSERT INTO "local_promo_codes" ("code", "amount_cents", "max_redemptions", "expires_at")
VALUES ('subscription_trial', 9900, NULL, NULL)
ON CONFLICT ("code") DO NOTHING;
