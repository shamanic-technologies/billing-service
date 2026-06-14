-- Per-campaign authorize-cost estimate (campaign affordability pre-flight gate).
-- One row per campaign holding the required_cents of the most recent authorize
-- attempt for that campaign (upserted on both sufficient and insufficient
-- outcomes). Read by GET /internal/campaigns/:campaignId/affordability so
-- campaign-service can skip re-triggering a run an out-of-credit org cannot
-- afford. Idempotent: safe to re-run on partial apply.
CREATE TABLE IF NOT EXISTS "campaign_authorize_costs" (
  "campaign_id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "last_authorize_required_cents" numeric(16,10) NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
