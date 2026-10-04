-- SALES-PATH ITEM BUDGETS (owner 2026-10-04, "you choose, we run").
--
-- A customer activates sales paths per offer (brand-service owns which) and states
-- ONE budget per (channel x leg) ITEM of each path. billing holds those budgets and
-- turns them into what the customer pays:
--   sales_path_item_budgets          one row per (org, brand, offer, path, channel, leg).
--                                    period = day (prepaid/postpaid) | month (subscriber).
--                                    At most ONE proactive (entry) item per
--                                    (org, brand, offer, channel, leg): one active path
--                                    per entry.
--   sales_path_item_budget_changes   append-only journal; items NULL = path removed.
--   sales_path_reactive_charges      a subscriber's reactive budget charged NOW for the
--                                    current period (delta over what the period already
--                                    collected for reactive items).
--   subscriptions.item_reactive_monthly_cents   reactive part of the plan amount.
--   subscription_charges.reactive_cents         reactive part of a period's plan charge.
--   subscription_credit_expiries.carried_over_cents  unspent reactive credit carried to
--                                    the next period instead of expiring.
-- No row anywhere = the brand reads exactly as before (global / campaigns mode).
--
-- Idempotent, writes no row. Reverse:
--   DROP TABLE IF EXISTS sales_path_reactive_charges, sales_path_item_budget_changes, sales_path_item_budgets;
--   ALTER TABLE subscriptions DROP COLUMN IF EXISTS item_reactive_monthly_cents;
--   ALTER TABLE subscription_charges DROP COLUMN IF EXISTS reactive_cents;
--   ALTER TABLE subscription_credit_expiries DROP COLUMN IF EXISTS carried_over_cents;
CREATE TABLE IF NOT EXISTS "sales_path_item_budgets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL,
  "path_key" text NOT NULL,
  "feature_slug" text NOT NULL,
  "leg_key" text NOT NULL,
  "role" text NOT NULL,
  "period" text NOT NULL,
  "budget_cents" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_path_item_budgets_role_check" CHECK ("role" IN ('proactive', 'reactive')),
  CONSTRAINT "sales_path_item_budgets_period_check" CHECK ("period" IN ('day', 'month')),
  CONSTRAINT "sales_path_item_budgets_positive" CHECK ("budget_cents" > 0),
  CONSTRAINT "sales_path_item_budgets_item_unique" UNIQUE ("org_id", "brand_id", "offer_id", "path_key", "feature_slug", "leg_key")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_sales_path_item_budgets_one_entry"
  ON "sales_path_item_budgets" ("org_id", "brand_id", "offer_id", "feature_slug", "leg_key")
  WHERE "role" = 'proactive';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sales_path_item_budgets_org_brand"
  ON "sales_path_item_budgets" ("org_id", "brand_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_path_item_budget_changes" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL,
  "path_key" text NOT NULL,
  "items" jsonb,
  "changed_by_user_id" uuid,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sales_path_item_budget_changes_org_brand"
  ON "sales_path_item_budget_changes" ("org_id", "brand_id", "changed_at", "id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_path_reactive_charges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "subscription_id" uuid NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "cumulative_cents" integer NOT NULL,
  "amount_cents" integer NOT NULL,
  "status" text NOT NULL,
  "reference" text,
  "failure_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_path_reactive_charges_status_check" CHECK ("status" IN ('paid', 'failed')),
  CONSTRAINT "sales_path_reactive_charges_amount_positive" CHECK ("amount_cents" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sales_path_reactive_charges_sub_period"
  ON "sales_path_reactive_charges" ("subscription_id", "period_start");
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "item_reactive_monthly_cents" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_charges" ADD COLUMN IF NOT EXISTS "reactive_cents" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_credit_expiries" ADD COLUMN IF NOT EXISTS "carried_over_cents" numeric(16, 10) DEFAULT 0 NOT NULL;
