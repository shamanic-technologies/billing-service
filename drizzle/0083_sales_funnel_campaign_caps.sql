-- MAX BUDGET + MAX VOLUME of ONE sales funnel CAMPAIGN (2026-10-11, the
-- distribute.you Copilot's person-targeted follow-ups).
--
-- campaign-service lets several funnel campaigns share ONE sales funnel when each
-- names different people (Marie's follow-up and Paul's follow-up both run
-- "follow_up_due -> AI Follow-up Email"). A cap keyed per (org, brand, offer,
-- funnel) cannot tell them apart: Marie's first send consumed Paul's "max volume
-- 1". A row may now name campaign-service's funnel campaign id
-- (`sales_funnel_campaign_id`); NULL = the funnel-wide cap, exactly as before.
--
-- The primary key (org, brand, offer, funnel) becomes a UNIQUE NULLS NOT DISTINCT
-- key over (org, brand, offer, funnel, sales_funnel_campaign_id): every existing
-- row carries NULL and keeps its one-row-per-funnel guarantee.
--
-- Idempotent. No row is written. Reverse (only once no campaign-scoped row exists):
--   ALTER TABLE sales_funnel_caps DROP CONSTRAINT sales_funnel_caps_key;
--   ALTER TABLE sales_funnel_caps ADD CONSTRAINT sales_funnel_caps_pkey PRIMARY KEY (org_id, brand_id, offer_id, sales_funnel_id);
--   ALTER TABLE sales_funnel_caps DROP COLUMN sales_funnel_campaign_id;
--   ALTER TABLE sales_funnel_cap_changes DROP COLUMN sales_funnel_campaign_id;
ALTER TABLE "sales_funnel_caps" ADD COLUMN IF NOT EXISTS "sales_funnel_campaign_id" text;
--> statement-breakpoint
ALTER TABLE "sales_funnel_cap_changes" ADD COLUMN IF NOT EXISTS "sales_funnel_campaign_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sales_funnel_caps" ADD CONSTRAINT "sales_funnel_caps_key"
    UNIQUE NULLS NOT DISTINCT ("org_id", "brand_id", "offer_id", "sales_funnel_id", "sales_funnel_campaign_id");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "sales_funnel_caps" DROP CONSTRAINT IF EXISTS "sales_funnel_caps_pkey";
