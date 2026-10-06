-- Owner Telegram alert per customer billing event (lib/owner-alerts). One row per
-- event a re-run could report twice (a sweep ending a subscription, a refused
-- charge per org per day): the primary key is the once-only claim. No row written.
CREATE TABLE IF NOT EXISTS "owner_alerts" (
  "dedup_key" text PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "text" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
