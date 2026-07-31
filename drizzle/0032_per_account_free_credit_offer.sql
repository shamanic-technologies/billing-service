-- Free-credit offer becomes a PER-ACCOUNT property instead of a global constant.
--
-- The offer is "$N in free credits in total, the remainder earned once your cumulative
-- succeeded payments reach $N". Both figures used to be module-level constants
-- (FREE_CREDIT_ENTITLEMENT_CENTS / FREE_CREDIT_PAID_TRIGGER_CENTS, $25/$25), so
-- re-pricing the offer re-priced it for EVERY existing customer at once.
--
-- distribute is re-pricing the offer to $400. The product decision is that the new
-- offer is for NEW customers only: every org that already exists keeps the $25 offer
-- it signed up under, permanently. So the amount an org is entitled to is written onto
-- its billing account ONCE, from the column DEFAULT, when the account is created, and
-- never updated afterwards. A future re-price then only moves the DEFAULT: existing
-- rows are untouched by construction, with no cutoff date to maintain and no backfill.
-- (Contrast WELCOME_COMPLETION_LAUNCH_AT_ISO, which needs a date because it is a claim
-- about payment HISTORY. This one is a claim about the account itself, so the row
-- carries it.)
--
-- Two statements per column, and the ORDER is the whole trick:
--   1. ADD COLUMN ... DEFAULT 2500 — Postgres backfills every EXISTING row with 2500,
--      which is exactly the offer those orgs signed up under. Nothing is re-priced,
--      nothing is granted: the columns only change which number later reads compare
--      against, and for a pre-existing account that number is unchanged.
--   2. ALTER COLUMN ... SET DEFAULT 40000 — every account created from here on gets
--      the new offer. Existing rows already hold their value, so this cannot reach them.
--
-- Idempotent: on a re-apply the columns already exist, so ADD COLUMN IF NOT EXISTS is a
-- no-op (it will NOT re-stamp 2500 onto the $400 accounts created since), and SET
-- DEFAULT is idempotent by nature.
--
-- The $5 up-front `welcome` gift is deliberately untouched: it is $5 for both cohorts.
-- The completion remainder stays DERIVED (this account's entitlement MINUS what the org
-- was already gifted), so both cohorts and the unchanged $5 all stay correct.

ALTER TABLE "billing_accounts"
  ADD COLUMN IF NOT EXISTS "free_credit_entitlement_cents" integer NOT NULL DEFAULT 2500;

ALTER TABLE "billing_accounts"
  ADD COLUMN IF NOT EXISTS "free_credit_paid_trigger_cents" integer NOT NULL DEFAULT 2500;

ALTER TABLE "billing_accounts"
  ALTER COLUMN "free_credit_entitlement_cents" SET DEFAULT 40000;

ALTER TABLE "billing_accounts"
  ALTER COLUMN "free_credit_paid_trigger_cents" SET DEFAULT 40000;
