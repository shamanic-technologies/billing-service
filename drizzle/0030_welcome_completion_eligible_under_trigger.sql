-- Welcome-completion eligibility: exclude ONLY the orgs that had already crossed the
-- $25 payment trigger before the automation launched — not every org that existed.
--
-- Migration 0029 implemented "no backfill" as "every account that existed at ship
-- time is permanently ineligible". That is much wider than the rule. "No backfill"
-- means: do not retroactively credit an org whose payments had ALREADY satisfied the
-- trigger before the offer existed. Measured against production, 88 accounts were
-- marked ineligible and only 10 of them had actually crossed $25 — so 78 were
-- excluded wrongly, 67 of them still gifted under $25 in total. Those 67 are exactly
-- the population the automation was built for: they signed up long ago, hold the $5
-- welcome row, have not paid $25 yet, and the founder was hand-granting each one.
--
-- So: give every pre-existing account its eligibility back. The genuine exclusion is
-- decided per org from Stripe's own payment history (billing does not store
-- cumulative payments, it reads them), resolved at settle time by
-- lib/welcome-completion.ts and frozen back onto this column. Nothing can be granted
-- in between: the grandfather check runs inside the same settle call, before the
-- INSERT.
--
-- Idempotent, and it can never demote a later signup:
--   * `created_at < launch` scopes it to pre-existing accounts, and post-launch
--     accounts are TRUE already, so they are untouched on every re-apply;
--   * re-applying after a resolution re-promotes one of the excluded orgs, and its
--     next settle re-derives the identical answer from the same immutable pre-launch
--     payments and re-freezes FALSE. No org's outcome changes, and no grant can slip
--     through in between (the check precedes the INSERT).
-- The cutoff is a literal, matching WELCOME_COMPLETION_LAUNCH_AT_ISO in db/schema.ts.
UPDATE "billing_accounts"
   SET "welcome_completion_eligible" = true,
       "updated_at" = now()
 WHERE "created_at" < '2026-07-30T00:00:00Z'
   AND "welcome_completion_eligible" = false;
