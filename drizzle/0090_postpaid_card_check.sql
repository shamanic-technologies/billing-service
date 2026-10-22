-- A POSTPAID org gets its credit line only once its card held the first step
-- (owner 2026-10-22, CARD-HOLD-50-1022: Jarygo Studios saved a debit card, ran
-- $36.93 on the $50 line, and both $50 charges were declined for insufficient
-- funds). See lib/postpaid-card-check.
--
-- Orgs ALREADY postpaid keep running as they do (no retroactive hold): they are
-- 'grandfathered'. The cut is a literal instant, never now(), so a re-apply cannot
-- grandfather an account created after the ship (the first apply, at deploy, is what
-- decides; the literal only bounds a re-apply). Every other row (and every new
-- account, via the column DEFAULT) is 'required'.
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS postpaid_card_check text NOT NULL DEFAULT 'required';--> statement-breakpoint
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS postpaid_card_check_message text;--> statement-breakpoint
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS postpaid_card_checked_at timestamptz;--> statement-breakpoint
UPDATE billing_accounts
SET postpaid_card_check = 'grandfathered'
WHERE payment_mode = 'postpaid'
  AND postpaid_card_check = 'required'
  AND created_at < '2026-10-22T12:00:00Z';
