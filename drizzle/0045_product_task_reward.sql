-- Product-task reward: a small fixed credit paid to an org each time it completes a
-- product task.
--
-- The same task recurs for the same org roughly every month, forever, so this reason
-- CANNOT dedup on (org, promo_code) the way invite_reward / invite_welcome do — that
-- shape pays once and then silently never again. It stacks instead, on the caller's
-- own per-completion identifier: rows carry `idempotency_key = 'task:<completionId>'`,
-- which exempts them from `idx_local_promos_org_promo` (partial, WHERE idempotency_key
-- IS NULL, migration 0025) and dedups on `idx_local_promos_org_idempotency`.
--
-- Nothing about the existing grants changes: no column, no index, no row is touched.
-- This is a SEED ONLY, and the per-row amount lives on local_promos, so this code
-- row's amount_cents is a 0 placeholder (each caller states what a completion is
-- worth). Journaled, because an unjournaled seed never runs in prod (see 0017).
--
-- Idempotent — safe to re-run.
-- Reverse: DELETE FROM "local_promo_codes" WHERE "code" = 'product_task_completed'
--          AND NOT EXISTS (SELECT 1 FROM "local_promos" p
--                          WHERE p."promo_code_id" = "local_promo_codes"."id");

INSERT INTO "local_promo_codes" ("code", "amount_cents", "max_redemptions", "expires_at")
VALUES ('product_task_completed', 0, NULL, NULL)
ON CONFLICT ("code") DO NOTHING;
