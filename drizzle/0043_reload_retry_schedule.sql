-- A spaced retry schedule for a failing auto-topup, and a DURABLE record of
-- having told the customer.
--
-- 0042 stood an org down until `credited` moved, which is right for a dead card
-- and wrong for the far more common case: a customer who is momentarily short
-- and would pay on Thursday. It traded "re-present the card 24x a day forever"
-- for "never retry at all", and the only remaining deterministic attempt was the
-- month-end sweep. These columns put the answer in between — attempt again on a
-- widening schedule anchored at the FIRST failure of the streak, then stop and
-- let the monthly sweep own it.
--
-- `notified_at` closes a separate hole: the "tell them once per streak" gate was
-- the in-memory failure counter in lib/reload-coalescer, which a deploy resets.
-- We deploy several times a day, so "once per streak" silently meant "once per
-- deploy". A column survives a restart; the counter never could.
--
-- BACKFILL: every existing failed row is stamped as already-notified and as
-- attempt 1, anchored at its own attempt — so the first tick after this deploy
-- cannot re-mail anyone about a refusal they were already told about, and the
-- schedule starts from when the card actually first refused rather than from
-- the deploy.
--
-- Reverse:
--   ALTER TABLE campaign_reload_sweep_attempts
--     DROP COLUMN IF EXISTS attempt_count,
--     DROP COLUMN IF EXISTS first_failed_at,
--     DROP COLUMN IF EXISTS notified_at;
ALTER TABLE campaign_reload_sweep_attempts
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1;

ALTER TABLE campaign_reload_sweep_attempts
  ADD COLUMN IF NOT EXISTS first_failed_at timestamp with time zone;

ALTER TABLE campaign_reload_sweep_attempts
  ADD COLUMN IF NOT EXISTS notified_at timestamp with time zone;

UPDATE campaign_reload_sweep_attempts
SET first_failed_at = COALESCE(first_failed_at, attempted_at),
    notified_at = COALESCE(notified_at, attempted_at)
WHERE last_outcome = 'failed';
