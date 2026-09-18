-- Trial seed: free credit for an organisation that has NOT signed up yet.
--
-- The dashboard now walks a visitor through their whole setup before asking for an
-- account or a card. That work is metered spend against an ordinary org that simply
-- has no identity-provider identity yet, so a stranger typing a URL spends our money.
-- What caps them is CREDIT: the org is seeded with a very small amount and the
-- affordability gate this service already enforces refuses the first call it cannot
-- afford. No new counter, no new threshold.
--
-- It is its OWN ledger key, never the welcome gift: the two mean different things and
-- the customer eventually sees the welcome one by name. At signup the org receives the
-- REMAINDER (welcome − seeded), so its TOTAL free credit is the welcome amount — not
-- the welcome amount plus the seed. Unspent seed is never clawed back.
--
-- Nothing about the existing grants changes: no column, no index, no row is touched.
-- This is a SEED ONLY, and the per-row amount lives on local_promos (it is derived
-- from the live `welcome` amount), so this code row's amount_cents is a 0 placeholder.
-- Journaled, because an unjournaled seed never runs in prod (see 0017).
--
-- Idempotent — safe to re-run.
-- Reverse: DELETE FROM "local_promo_codes" WHERE "code" = 'trial_seed'
--          AND NOT EXISTS (SELECT 1 FROM "local_promos" p
--                          WHERE p."promo_code_id" = "local_promo_codes"."id");

INSERT INTO "local_promo_codes" ("code", "amount_cents", "max_redemptions", "expires_at")
VALUES ('trial_seed', 0, NULL, NULL)
ON CONFLICT ("code") DO NOTHING;
