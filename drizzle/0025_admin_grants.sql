-- Admin-issued, stacking, arbitrary-amount credit grants (staff oversight ledger).
--
-- 1) granted_by + idempotency_key columns on local_promos.
-- 2) Make the (org_id, promo_code_id) uniqueness PARTIAL — WHERE idempotency_key
--    IS NULL — so invite / welcome / promo-redemption rows keep their
--    one-per-(org, promo_code) idempotency, while admin_grant rows (which set
--    idempotency_key) are EXEMPT and can STACK (many grants per org).
-- 3) Partial unique (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL —
--    a retried admin grant with the same key never double-grants.
-- 4) Seed the admin_grant promo code. Per-row amount lives on local_promos (like
--    first_load_match); this code row's amount_cents is a 0 placeholder.
--
-- Idempotent — safe to re-run (drizzle migrator + the hand-built test schema).
--
-- NOTE (DIS-64 latent fix): this is a JOURNALED migration (unlike the orphaned
-- 0017). The same INSERT pattern that seeds admin_grant here is the reason the
-- prod grant path was 500ing — seeding via a journaled migration ensures the
-- code rows actually exist in prod.

ALTER TABLE "local_promos" ADD COLUMN IF NOT EXISTS "granted_by" text;
ALTER TABLE "local_promos" ADD COLUMN IF NOT EXISTS "idempotency_key" text;

-- Repoint the (org, promo_code) uniqueness to the non-admin rows only.
DROP INDEX IF EXISTS "idx_local_promos_org_promo";
CREATE UNIQUE INDEX IF NOT EXISTS "idx_local_promos_org_promo"
  ON "local_promos" ("org_id", "promo_code_id")
  WHERE "idempotency_key" IS NULL;

-- Stacking dedup for admin_grant rows.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_local_promos_org_idempotency"
  ON "local_promos" ("org_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

INSERT INTO "local_promo_codes" ("code", "amount_cents", "max_redemptions", "expires_at")
VALUES ('admin_grant', 0, NULL, NULL)
ON CONFLICT ("code") DO NOTHING;
