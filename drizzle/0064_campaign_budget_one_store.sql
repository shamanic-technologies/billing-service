-- ONE STORE PER CAMPAIGN (owner + dashboard, 2026-10-04). A campaign's budget lives
-- on its ceiling row (campaign_daily_budgets, one row per offer x leg x channel),
-- the row campaign-service already spends. 0063's separate campaign_item_budgets
-- (never written in prod) would have been a second figure for the same campaign;
-- it is dropped. A subscriber's MONTHLY budget is stored on the ceiling row as
-- monthly_budget_cents, its daily ceiling being monthly / 30, so every daily reader
-- stays coherent. NULL = a daily-only ceiling (every existing row).
--
-- Fails loud instead of dropping data if 0063's table ever held a row.
-- Reverse: ALTER TABLE campaign_daily_budgets DROP COLUMN IF EXISTS monthly_budget_cents;
DO $$
BEGIN
  IF to_regclass('public.campaign_item_budgets') IS NOT NULL
     AND EXISTS (SELECT 1 FROM campaign_item_budgets) THEN
    RAISE EXCEPTION 'campaign_item_budgets holds rows: migrate them before 0064';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "campaign_item_budget_changes";
--> statement-breakpoint
DROP TABLE IF EXISTS "campaign_item_budgets";
--> statement-breakpoint
ALTER TABLE "campaign_daily_budgets" ADD COLUMN IF NOT EXISTS "monthly_budget_cents" integer;
--> statement-breakpoint
ALTER TABLE "campaign_daily_budgets" DROP CONSTRAINT IF EXISTS "campaign_daily_budgets_monthly_positive";
--> statement-breakpoint
ALTER TABLE "campaign_daily_budgets" ADD CONSTRAINT "campaign_daily_budgets_monthly_positive" CHECK ("monthly_budget_cents" IS NULL OR "monthly_budget_cents" > 0);
