-- Drop the abandoned first-load-match ledger key.
--
-- `first_load_match` backed `POST /v1/accounts/wallet_setup` (a dollar-for-dollar
-- match on an org's first paid load, capped at $25). That whole path is dead:
--   * the dashboard deliberately migrated onboarding off it (its own
--     onboarding-flow test asserts the flow does NOT contain `wallet_setup`), and
--     the `walletSetup()` helper it left behind has zero call sites;
--   * prod has NEVER completed one — zero payment_intents carry
--     metadata.billing_reason='initial_load' (0 of 1255);
--   * the promise it encoded ("$25 free once you put money in") is now served by
--     `welcome_completion` (migration 0029), on the checkout path onboarding
--     actually uses.
--
-- Keeping it would be worse than dead code: `grantFirstLoadMatch` capped at $25
-- ON ITS OWN with no reference to the $25 TOTAL free-credit entitlement, so
-- welcome ($5) + first_load_match ($25) = $30 free — it contradicts the
-- entitlement rule 0029 established.
--
-- ⚠️ In prod this row is named `brand_welcome`, not `first_load_match`. Migration
-- 0023 inserted it as `first_load_match` on 2026-06-17; someone later ran an
-- in-place UPDATE renaming the code and setting amount_cents 0 -> 2500. Migrations
-- are one-shot, so 0023 never restored the original name. Nothing in any repo
-- reads `brand_welcome` and it has zero grants — it is the same orphan row.
--
-- Both names are handled so this is correct on prod (renamed), on a fresh DB
-- (original name), and on a DB where neither exists.
--
-- GUARDED: a code is only removed when NO local_promos row references it, so this
-- can never orphan a real grant or trip the FK. Idempotent: re-applying is a no-op.
DELETE FROM "local_promo_codes" c
 WHERE c."code" IN ('first_load_match', 'brand_welcome')
   AND NOT EXISTS (
     SELECT 1 FROM "local_promos" p WHERE p."promo_code_id" = c."id"
   );
