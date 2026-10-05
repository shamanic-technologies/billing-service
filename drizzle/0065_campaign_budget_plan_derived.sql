-- A SUBSCRIBER's campaign budget DERIVED FROM ITS PLAN (owner 2026-10-05). A
-- subscriber whose campaigns still carried a legacy DAILY ceiling (written before
-- monthly budgets existed, e.g. a $50/day default) read it x30 as its monthly
-- budget ("$1,500/month") while paying a $99 plan. The plan is the budget:
-- lib/subscriber-plan-budgets restates those rows as monthly figures derived from
-- the live plan and stamps them plan_derived = true. A derived row never prices
-- the plan and is never charged on top of it (it IS the plan); the customer
-- restating the row through either budget route clears the flag.
-- Reverse: ALTER TABLE campaign_daily_budgets DROP COLUMN IF EXISTS plan_derived;
ALTER TABLE "campaign_daily_budgets" ADD COLUMN IF NOT EXISTS "plan_derived" boolean DEFAULT false NOT NULL;
