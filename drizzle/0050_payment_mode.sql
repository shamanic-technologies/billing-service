-- How an org pays: PREPAID or POSTPAID — the customer's explicit choice, never
-- inferred from whether a card is on file.
--
-- POSTPAID is exactly today's behaviour: a credit line the balance may run below
-- zero into, a card required to collect on it, and "no chargeable card" is a
-- charge_blocked verdict that stops the org's campaigns.
--
-- PREPAID spends only money already paid in: floor 0, no card required. Having no
-- card, or auto top-up off, never produces a charge_blocked verdict; spend simply
-- stops when the balance reaches zero, through the existing affordability check.
--
-- Every EXISTING row lands on 'postpaid' through ADD COLUMN ... DEFAULT, so no org
-- changes behaviour. New accounts are postpaid too until someone chooses otherwise.
--
-- Idempotent — safe to re-run. Reverse:
--   ALTER TABLE billing_accounts DROP CONSTRAINT IF EXISTS billing_accounts_payment_mode_check;
--   ALTER TABLE billing_accounts DROP COLUMN IF EXISTS payment_mode;
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "payment_mode" text NOT NULL DEFAULT 'postpaid';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'billing_accounts_payment_mode_check'
  ) THEN
    ALTER TABLE "billing_accounts"
      ADD CONSTRAINT "billing_accounts_payment_mode_check"
      CHECK ("payment_mode" IN ('prepaid', 'postpaid'));
  END IF;
END $$;
