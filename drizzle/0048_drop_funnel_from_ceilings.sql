-- The sales funnel leaves billing-service: a daily ceiling is keyed on the
-- CAMPAIGN alone, (offer x leg x acquisition channel).
--
-- The fleet retired the sales-funnel concept (one leg belongs to several funnels,
-- so the funnel never identified what was bought). Migration 0047 made funnel_key
-- nullable; this drops it, renames the table to what it now holds, and rekeys the
-- unique constraint on the campaign.
--
-- BEFORE this ran, the table was snapshotted in production as
-- brand_funnel_daily_budgets_funnel_snapshot_20260926 (every column, every row,
-- funnel_key included), with its row count checked against the source.
--
-- NO money moves. Dropping funnel_key keeps every row as it is; the only way two
-- rows could collapse onto one campaign key is two funnels funding the same
-- (org, brand, channel, offer, leg), and the guard below REFUSES that rather than
-- merging silently (measured in production before shipping: zero such pairs).
-- A refusal fails the boot migration, which rolls the deploy back with nothing
-- applied.
--
-- Idempotent: every step is guarded, so a re-apply is a no-op.
--
-- Reverse (restores the shape; the funnel values come back from the snapshot):
--   ALTER TABLE campaign_daily_budgets RENAME TO brand_funnel_daily_budgets;
--   ALTER TABLE brand_funnel_daily_budgets ADD COLUMN funnel_key text;
--   UPDATE brand_funnel_daily_budgets b SET funnel_key = s.funnel_key
--     FROM brand_funnel_daily_budgets_funnel_snapshot_20260926 s
--    WHERE (b.org_id, b.brand_id, b.feature_slug) = (s.org_id, s.brand_id, s.feature_slug)
--      AND b.offer_id IS NOT DISTINCT FROM s.offer_id
--      AND b.leg_key IS NOT DISTINCT FROM s.leg_key;
ALTER TABLE IF EXISTS "brand_funnel_daily_budgets" RENAME TO "campaign_daily_budgets";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "campaign_daily_budgets"
     GROUP BY org_id, brand_id, feature_slug, offer_id, leg_key
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'campaign_daily_budgets: two ceilings fund one campaign under different funnels; consolidate them before dropping funnel_key';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "campaign_daily_budgets" DROP CONSTRAINT IF EXISTS "brand_funnel_daily_budgets_leg_key";
--> statement-breakpoint
DROP INDEX IF EXISTS "brand_funnel_daily_budgets_org_brand_funnel_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "brand_funnel_daily_budgets_org_brand_funnel_channel_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "brand_funnel_daily_budgets_org_brand_funnel_channel_offer_idx";
--> statement-breakpoint
ALTER TABLE "campaign_daily_budgets" DROP COLUMN IF EXISTS "funnel_key";
--> statement-breakpoint
ALTER INDEX IF EXISTS "brand_funnel_daily_budgets_org_brand_idx" RENAME TO "campaign_daily_budgets_org_brand_idx";
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'campaign_daily_budgets_campaign_key'
  ) THEN
    ALTER TABLE "campaign_daily_budgets"
      ADD CONSTRAINT "campaign_daily_budgets_campaign_key"
      UNIQUE NULLS NOT DISTINCT (org_id, brand_id, feature_slug, offer_id, leg_key);
  END IF;
END $$;
