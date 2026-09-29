-- A brand's ONE daily budget for SALES (global mode).
--
-- A brand that states one here runs in "global" mode: campaign-service puts the
-- money behind the best-return sales path instead of pacing each campaign on its
-- own ceiling (campaign_daily_budgets, which this migration does not touch). No
-- row = "campaigns" mode, exactly as before. Clearing deletes the row.
--
-- brand_sales_budget_changes is the append-only history; a NULL amount records a
-- clear. Written in the same transaction as the brand_sales_budgets write.
--
-- Idempotent. Reverse:
--   DROP TABLE IF EXISTS brand_sales_budget_changes;
--   DROP TABLE IF EXISTS brand_sales_budgets;
CREATE TABLE IF NOT EXISTS "brand_sales_budgets" (
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "daily_budget_cents" numeric(16, 10) NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "brand_sales_budgets_pkey" PRIMARY KEY ("org_id", "brand_id"),
  CONSTRAINT "brand_sales_budgets_non_negative" CHECK ("daily_budget_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brand_sales_budget_changes" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "daily_budget_cents" numeric(16, 10),
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_sales_budget_changes_org_brand_changed_at_idx"
  ON "brand_sales_budget_changes" ("org_id", "brand_id", "changed_at", "id");
