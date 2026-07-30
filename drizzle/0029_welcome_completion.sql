-- Welcome-completion gift — the second half of the "$25 in free credits" promise.
--
-- Onboarding tells every new customer they get $25 of free credits. Signup only
-- grants the `welcome` row ($5 today), so the remainder was being granted BY HAND
-- (staff `admin_grant` rows described "Welcome credits (2/2)"). This ledger key
-- makes the remainder automatic: it is granted exactly once per org, the moment
-- the org's cumulative SUCCEEDED payments reach $25.
--
-- The promo-code row is a technical ledger key only (amount 0): the actual grant
-- amount is dynamic (entitlement $25 MINUS whatever the org has already been
-- gifted) and is stored per row on local_promos, exactly like `first_load_match`.
INSERT INTO "local_promo_codes" ("code", "amount_cents", "max_redemptions", "expires_at")
VALUES ('welcome_completion', 0, NULL, NULL)
ON CONFLICT ("code") DO UPDATE SET "amount_cents" = EXCLUDED."amount_cents";

-- NO BACKFILL (product decision, 2026-07-30): the $25 gift is the CURRENT offer,
-- not a retroactive entitlement. Orgs that already existed when this shipped keep
-- exactly the grants they have — several are on the old $2-era welcome amount and
-- several have no welcome row at all, and re-pricing history is explicitly out of
-- scope. So the column defaults to TRUE (a brand-new org is eligible) and this
-- one-time UPDATE marks every pre-existing account ineligible.
--
-- The cutoff literal (not now()) keeps the migration idempotent: re-applying it
-- can never demote an account created after the feature shipped.
ALTER TABLE "billing_accounts"
  ADD COLUMN IF NOT EXISTS "welcome_completion_eligible" boolean NOT NULL DEFAULT true;

UPDATE "billing_accounts"
   SET "welcome_completion_eligible" = false
 WHERE "created_at" < '2026-07-30T00:00:00Z'
   AND "welcome_completion_eligible" = true;
