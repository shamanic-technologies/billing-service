-- A subscription PLAN belongs to one brand x offer (owner decision 2026-10-03), so
-- an org can hold several plans at once. lib/subscription.
--
--   subscriptions.brand_id / offer_id   nullable: NULL = a plan started before
--       plans were per offer (the onboarding route sends neither). Such a plan is
--       attributed to the org's FIRST brand x offer the first time it is read, and
--       stamped then. Never backfilled here: billing does not hold the brand list.
--   one live plan per (org, brand, offer), NULLS NOT DISTINCT, so an org still holds
--       at most ONE unattributed live plan (exactly the old per-org rule for it).
--   subscription_credit_expiries is keyed per (subscription, boundary): two plans
--       of one org may cross a boundary at the same instant.
--
-- Prod at ship time: 1 subscription (trialing), no expiry row. Idempotent. Reverse:
--   DROP INDEX IF EXISTS idx_subscriptions_one_live_per_plan;
--   CREATE UNIQUE INDEX idx_subscriptions_one_live_per_org ON subscriptions (org_id) WHERE status <> 'canceled';  -- only while no org holds 2 live plans
--   ALTER TABLE subscription_credit_expiries DROP CONSTRAINT IF EXISTS subscription_credit_expiries_sub_boundary;
--   ALTER TABLE subscription_credit_expiries ADD CONSTRAINT subscription_credit_expiries_org_boundary UNIQUE (org_id, boundary_at);
--   ALTER TABLE subscriptions DROP COLUMN IF EXISTS brand_id, DROP COLUMN IF EXISTS offer_id;
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "brand_id" uuid;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "offer_id" uuid;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_subscriptions_one_live_per_org";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_subscriptions_one_live_per_plan" ON "subscriptions" ("org_id", "brand_id", "offer_id") NULLS NOT DISTINCT WHERE "status" <> 'canceled';
--> statement-breakpoint
ALTER TABLE "subscription_credit_expiries" DROP CONSTRAINT IF EXISTS "subscription_credit_expiries_org_boundary";
--> statement-breakpoint
ALTER TABLE "subscription_credit_expiries" DROP CONSTRAINT IF EXISTS "subscription_credit_expiries_sub_boundary";
--> statement-breakpoint
ALTER TABLE "subscription_credit_expiries" ADD CONSTRAINT "subscription_credit_expiries_sub_boundary" UNIQUE ("subscription_id", "boundary_at");
