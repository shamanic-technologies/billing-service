-- A funnel MAX BUDGET can be monthly or one-off, so it must hold more than the
-- numeric(16,10) every DAILY ceiling uses (6 integer digits = $9,999.99): a
-- $10,000 monthly cap overflowed (PUT answered 500, 2026-10-10 prod probe).
-- Widened to numeric(22,10) (12 integer digits); the route refuses anything
-- larger with a 400. Widening keeps every value; no row is rewritten in meaning.
--
-- Idempotent (re-applying the same type is a no-op). Reverse:
--   ALTER TABLE sales_funnel_caps ALTER COLUMN max_budget_cents TYPE numeric(16, 10);
--   ALTER TABLE sales_funnel_cap_changes ALTER COLUMN max_budget_cents TYPE numeric(16, 10);
ALTER TABLE "sales_funnel_caps" ALTER COLUMN "max_budget_cents" TYPE numeric(22, 10);
--> statement-breakpoint
ALTER TABLE "sales_funnel_cap_changes" ALTER COLUMN "max_budget_cents" TYPE numeric(22, 10);
