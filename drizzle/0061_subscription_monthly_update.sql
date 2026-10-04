-- The informational monthly update (owner 2026-10-04): every subscription org gets
-- one results email per closed period, apart from the promotional "month booked"
-- email. This column remembers the END of the last period that was reported, so a
-- period is reported once (claimed by a conditional UPDATE … RETURNING) and the
-- next report covers exactly what came after it. lib/subscription-monthly-update.
--
-- Backfill: every existing subscription is marked as reported through its CURRENT
-- period start, so the first send after the deploy is the next real boundary, never
-- a mail about a period that closed weeks ago.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the backfill only touches NULL rows.
-- Reverse: ALTER TABLE subscriptions DROP COLUMN IF EXISTS monthly_update_reported_through;
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "monthly_update_reported_through" timestamp with time zone;
--> statement-breakpoint
UPDATE "subscriptions" SET "monthly_update_reported_through" = "current_period_start" WHERE "monthly_update_reported_through" IS NULL;
