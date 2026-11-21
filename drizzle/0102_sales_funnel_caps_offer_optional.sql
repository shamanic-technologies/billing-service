-- A campaign may name NO offer (owner 2026-11-21, DISTRY-CALL-IS-CAMPAIGN-1121):
-- a campaign is Target + start + budget + brief; "check this email address" or
-- "draft a newsletter" has no offer to name. Its caps are keyed (org, brand,
-- NULL offer, funnel, funnel campaign): the key is already UNIQUE NULLS NOT
-- DISTINCT (0083), so a NULL offer still holds one row per key.
--
-- Idempotent (DROP NOT NULL on a nullable column is a no-op). No row is written.
-- Reverse (only once no offer-less row exists):
--   ALTER TABLE sales_funnel_caps ALTER COLUMN offer_id SET NOT NULL;
--   ALTER TABLE sales_funnel_cap_changes ALTER COLUMN offer_id SET NOT NULL;
ALTER TABLE "sales_funnel_caps" ALTER COLUMN "offer_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "sales_funnel_cap_changes" ALTER COLUMN "offer_id" DROP NOT NULL;
