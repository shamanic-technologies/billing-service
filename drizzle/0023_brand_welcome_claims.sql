-- Per-brand subscription welcome gift — the one-time $25 free credit.
--
-- welcome_credit_claims is the 4-key suppression ledger: one row per SUCCESSFUL
-- grant. The gift is un-farmable — a prior claim on ANY of org_id / user_id /
-- brand_id / card_fingerprint yields $0 next time. Each key has its OWN unique
-- index, so the grant is a plain INSERT the DB rejects (23505) when any key was
-- already claimed (race-safe, no SELECT-then-insert window). The money itself is
-- a local_promos row under the 'brand_welcome' code; local_promo_id references it.
--
-- Idempotent: safe to re-run on partial apply.
CREATE TABLE IF NOT EXISTS "welcome_credit_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "card_fingerprint" text NOT NULL,
  "amount_cents" numeric(16,10) NOT NULL,
  "local_promo_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_welcome_claims_org" ON "welcome_credit_claims" ("org_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_welcome_claims_user" ON "welcome_credit_claims" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_welcome_claims_brand" ON "welcome_credit_claims" ("brand_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_welcome_claims_card" ON "welcome_credit_claims" ("card_fingerprint");

-- Seed the per-brand welcome promo code (the money side of the gift). $25 = 2500.
-- Independent of the org-level 'welcome' code (which stays at $2 per 0019).
INSERT INTO "local_promo_codes" ("code", "amount_cents", "max_redemptions", "expires_at")
VALUES ('brand_welcome', 2500, NULL, NULL)
ON CONFLICT ("code") DO NOTHING;
