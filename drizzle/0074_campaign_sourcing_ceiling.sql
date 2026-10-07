-- A campaign's budget in two parts (lib/campaign-sourcing): daily_budget_cents
-- stays the campaign's MAX daily spend; sourcing_ceiling_cents is the part of it
-- sourcing may spend, on demand. Outreach = daily - sourcing, served, never stored.
-- NULL = not split (the whole chain on one budget, as before). One column on the
-- existing row: never a second store on the same grain. No row written here.
-- Reverse: ALTER TABLE campaign_daily_budgets DROP CONSTRAINT IF EXISTS campaign_daily_budgets_sourcing_within_total, DROP COLUMN IF EXISTS sourcing_ceiling_cents;
ALTER TABLE "campaign_daily_budgets" ADD COLUMN IF NOT EXISTS "sourcing_ceiling_cents" numeric(16,10);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "campaign_daily_budgets" ADD CONSTRAINT "campaign_daily_budgets_sourcing_within_total"
    CHECK ("sourcing_ceiling_cents" IS NULL OR ("sourcing_ceiling_cents" >= 0 AND "sourcing_ceiling_cents" <= "daily_budget_cents"));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
