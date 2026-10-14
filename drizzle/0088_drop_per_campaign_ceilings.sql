-- Retire the per-campaign daily ceilings (owner 2026-10-14, EDINBURGH-PERCAMPAIGN-STORE-RETIRE).
-- A campaign IS a sales funnel campaign: what it may spend is its sales funnel caps.
-- No service reads campaign_daily_budgets any more (campaign-service v0.75.72,
-- lead-service v0.83.101, features-service: served builds checked before this ships).
--
-- campaign_daily_budgets: 36 stale rows (21 orgs), last written 2026-10-10. Kept in a
-- snapshot table, then dropped. sales_path_reactive_charges: never held a row; its
-- only writer (per-campaign item budgets) is gone.
--
-- Idempotent: the snapshot is taken only while the source still exists.
-- Reverse: CREATE TABLE campaign_daily_budgets AS TABLE campaign_daily_budgets_snapshot_20261014;
DO $$
BEGIN
  IF to_regclass('public.campaign_daily_budgets') IS NOT NULL
     AND to_regclass('public.campaign_daily_budgets_snapshot_20261014') IS NULL THEN
    CREATE TABLE campaign_daily_budgets_snapshot_20261014 AS TABLE campaign_daily_budgets;
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS campaign_daily_budgets;
--> statement-breakpoint
DROP TABLE IF EXISTS sales_path_reactive_charges;
