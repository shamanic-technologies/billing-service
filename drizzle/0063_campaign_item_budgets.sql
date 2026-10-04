-- ITEM BUDGETS PER CAMPAIGN (owner decision 2026-10-04, superseding 0062's per-path key).
--
-- A budget belongs to a CAMPAIGN = (offer x leg x channel), not to an activated sales
-- path: two paths sharing a campaign share its budget, and a campaign is unique by
-- nature (no "entry taken"). 0062's per-path tables shipped inert and were never
-- written (0 rows in prod when this was authored); they are replaced here.
--   campaign_item_budgets          one row per (org, brand, offer, channel, leg).
--   campaign_item_budget_changes   append-only journal; budget_cents NULL = removed.
-- ON / OFF is NOT stored here: it is campaign-service's campaign status (the
-- customer's statement of intent). sales_path_reactive_charges and the 0062 columns
-- on subscriptions / subscription_charges / subscription_credit_expiries stay.
--
-- Fails loud instead of dropping data if the 0062 tables ever held a row.
-- Reverse: DROP TABLE IF EXISTS campaign_item_budget_changes, campaign_item_budgets;
--   DROP INDEX IF EXISTS idx_sales_path_reactive_charges_claim;
DO $$
BEGIN
  IF to_regclass('public.sales_path_item_budgets') IS NOT NULL
     AND EXISTS (SELECT 1 FROM sales_path_item_budgets) THEN
    RAISE EXCEPTION 'sales_path_item_budgets holds rows: migrate them before 0063';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "sales_path_item_budget_changes";
--> statement-breakpoint
DROP TABLE IF EXISTS "sales_path_item_budgets";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_item_budgets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL,
  "feature_slug" text NOT NULL,
  "leg_key" text NOT NULL,
  "role" text NOT NULL,
  "period" text NOT NULL,
  "budget_cents" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "campaign_item_budgets_role_check" CHECK ("role" IN ('proactive', 'reactive')),
  CONSTRAINT "campaign_item_budgets_period_check" CHECK ("period" IN ('day', 'month')),
  CONSTRAINT "campaign_item_budgets_positive" CHECK ("budget_cents" > 0),
  CONSTRAINT "campaign_item_budgets_campaign_unique" UNIQUE ("org_id", "brand_id", "offer_id", "feature_slug", "leg_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_campaign_item_budgets_org_brand"
  ON "campaign_item_budgets" ("org_id", "brand_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_item_budget_changes" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL,
  "feature_slug" text NOT NULL,
  "leg_key" text NOT NULL,
  "budget_cents" integer,
  "period" text,
  "changed_by_user_id" uuid,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_campaign_item_budget_changes_org_brand"
  ON "campaign_item_budget_changes" ("org_id", "brand_id", "changed_at", "id");
--> statement-breakpoint
-- A follow-up charge is CLAIMED (status pending) before the card is charged, once per
-- (plan, period, target total): two concurrent triggers (a budget write and a campaign
-- turned on) can never both charge the same delta. A failed claim may be re-claimed.
ALTER TABLE "sales_path_reactive_charges" DROP CONSTRAINT IF EXISTS "sales_path_reactive_charges_status_check";
--> statement-breakpoint
ALTER TABLE "sales_path_reactive_charges" ADD CONSTRAINT "sales_path_reactive_charges_status_check" CHECK ("status" IN ('pending', 'paid', 'failed'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_sales_path_reactive_charges_claim"
  ON "sales_path_reactive_charges" ("subscription_id", "period_start", "cumulative_cents");
