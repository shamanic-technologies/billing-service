-- Referral notification markers.
--
-- "Did we grant this" and "did we tell them about it" are different questions.
-- The hourly sweep re-examines every promise on every tick, so without a marker
-- of its own each pass would re-send the same email.
--
-- Two columns rather than one because the two moments are distinct and either can
-- happen without the other: a reward OPENS for an inviter when someone they
-- referred converts, and is GRANTED later when the inviter's own payments cross
-- its bar.
--
-- Idempotent: safe to replay.
ALTER TABLE "free_credit_promises"
  ADD COLUMN IF NOT EXISTS "opened_notified_at" timestamp with time zone;

ALTER TABLE "free_credit_promises"
  ADD COLUMN IF NOT EXISTS "granted_notified_at" timestamp with time zone;

-- Existing promises are backfilled as ALREADY NOTIFIED.
--
-- They pre-date the notification, so leaving them NULL would have the first sweep
-- after this deploy mail every customer about referral activity they have already
-- seen on their Billing page, some of it days old. A notification is only worth
-- sending about something that just happened.
UPDATE "free_credit_promises"
  SET "opened_notified_at" = now()
  WHERE "opened_notified_at" IS NULL;

UPDATE "free_credit_promises"
  SET "granted_notified_at" = now()
  WHERE "granted_notified_at" IS NULL AND "granted_at" IS NOT NULL;
