-- Stop re-presenting a card the bank has said is permanently unusable.
--
-- Card-network rules split declines in two, and the split is not advisory.
-- A TEMPORARY refusal (insufficient funds, a processing error, a generic
-- decline) may be retried, capped at 15 reattempts per 30 days. A PERMANENT one
-- (lost, stolen, pickup, account closed or never existed, authorization
-- revoked) may NEVER be resubmitted, at any interval. Our month-end sweep
-- retries forever by design and reads no decline reason at all, so a stolen
-- card would be re-presented every month for the life of the account: useless,
-- and against the rules.
--
-- `card_unusable_at` is the org-level record of that verdict; `last_decline_code`
-- is the reason we based it on, kept so a later reclassification can be audited
-- rather than guessed at. Both are CLEARED by any successful charge — a customer
-- who replaces the card is not held to the old one's verdict.
--
-- No backfill: the only row that exists today refused with `generic_decline`,
-- which is a TEMPORARY refusal and must keep being retried. Marking anything
-- here would stop collecting a debt we are entitled to collect.
--
-- Reverse:
--   ALTER TABLE campaign_reload_sweep_attempts
--     DROP COLUMN IF EXISTS last_decline_code,
--     DROP COLUMN IF EXISTS card_unusable_at;
ALTER TABLE campaign_reload_sweep_attempts
  ADD COLUMN IF NOT EXISTS last_decline_code text;

ALTER TABLE campaign_reload_sweep_attempts
  ADD COLUMN IF NOT EXISTS card_unusable_at timestamp with time zone;
