-- First-load wallet match.
-- The promo-code row is a technical ledger key: local_promos stores the actual
-- dynamic match amount for the org's first paid load, capped in application code.
INSERT INTO "local_promo_codes" ("code", "amount_cents", "max_redemptions", "expires_at")
VALUES ('first_load_match', 0, NULL, NULL)
ON CONFLICT ("code") DO UPDATE SET "amount_cents" = EXCLUDED."amount_cents";
