-- Organization-creation bonus: every newly created organization receives a small
-- free credit ONCE ($5), so its first setup steps can run. The welcome gift is once
-- per PERSON (0049), so a person's second organization otherwise starts at $0.
--
-- One-shot per org: rows carry NO idempotency_key, so `idx_local_promos_org_promo`
-- (partial unique on (org_id, promo_code_id) WHERE idempotency_key IS NULL) makes a
-- retry a no-op. The amount billing grants is THIS row's amount_cents (the live
-- figure, re-priceable via PATCH /internal/promo-codes/org_creation_bonus).
--
-- SEED ONLY: no column, no index, no existing row is touched. Journaled, because an
-- unjournaled seed never runs in prod (see 0017).
--
-- Idempotent — safe to re-run (ON CONFLICT DO NOTHING keeps a re-priced amount).
-- Reverse: DELETE FROM "local_promo_codes" WHERE "code" = 'org_creation_bonus'
--          AND NOT EXISTS (SELECT 1 FROM "local_promos" p
--                          WHERE p."promo_code_id" = "local_promo_codes"."id");

INSERT INTO "local_promo_codes" ("code", "amount_cents", "max_redemptions", "expires_at")
VALUES ('org_creation_bonus', 500, NULL, NULL)
ON CONFLICT ("code") DO NOTHING;
