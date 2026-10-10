-- MAX BUDGET and MAX VOLUME per SALES FUNNEL (owner 2026-10-10, "chat first").
--
-- A campaign becomes a sales funnel: a set of (leg x channel) pipes that
-- features-service names and identifies (its `combinationKey`, e.g.
-- `lead_found_to_website_visit@sales-cold-email-outreach+website_visit_to_purchase+purchase_to_paid_client`).
-- The customer states, per brand x offer x sales funnel, how much it may SPEND
-- and how much it may PRODUCE, each over a period (one_off, daily, weekly,
-- monthly). campaign-service reads them to stop the funnel's pipes.
--
-- This is NOT the retired `funnel_key` (0048): that key never identified what
-- was bought. A features-service sales funnel id names its exact pipes.
--
-- One row per (org, brand, offer, funnel). Either cap may be unset (NULL
-- amount + NULL period, enforced); a row with neither is deleted instead.
-- `*_since` = when that cap was first stated in its current period (a
-- one_off cap counts consumption from then; a restated amount keeps it).
--
-- sales_funnel_cap_changes is the append-only history (NULL caps = cleared),
-- written in the same transaction as the sales_funnel_caps write.
--
-- Idempotent. No row is written. Reverse:
--   DROP TABLE IF EXISTS sales_funnel_cap_changes;
--   DROP TABLE IF EXISTS sales_funnel_caps;
CREATE TABLE IF NOT EXISTS "sales_funnel_caps" (
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL,
  "sales_funnel_id" text NOT NULL,
  "max_budget_cents" numeric(16, 10),
  "max_budget_period" text,
  "max_budget_since" timestamp with time zone,
  "max_volume" integer,
  "max_volume_period" text,
  "max_volume_since" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_funnel_caps_pkey" PRIMARY KEY ("org_id", "brand_id", "offer_id", "sales_funnel_id"),
  CONSTRAINT "sales_funnel_caps_budget_non_negative" CHECK ("max_budget_cents" >= 0),
  CONSTRAINT "sales_funnel_caps_volume_non_negative" CHECK ("max_volume" >= 0),
  CONSTRAINT "sales_funnel_caps_budget_whole" CHECK (
    ("max_budget_cents" IS NULL) = ("max_budget_period" IS NULL)
    AND ("max_budget_cents" IS NULL) = ("max_budget_since" IS NULL)
  ),
  CONSTRAINT "sales_funnel_caps_volume_whole" CHECK (
    ("max_volume" IS NULL) = ("max_volume_period" IS NULL)
    AND ("max_volume" IS NULL) = ("max_volume_since" IS NULL)
  ),
  CONSTRAINT "sales_funnel_caps_budget_period" CHECK ("max_budget_period" IN ('one_off', 'daily', 'weekly', 'monthly')),
  CONSTRAINT "sales_funnel_caps_volume_period" CHECK ("max_volume_period" IN ('one_off', 'daily', 'weekly', 'monthly')),
  CONSTRAINT "sales_funnel_caps_something_stated" CHECK ("max_budget_cents" IS NOT NULL OR "max_volume" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_funnel_cap_changes" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL,
  "sales_funnel_id" text NOT NULL,
  "max_budget_cents" numeric(16, 10),
  "max_budget_period" text,
  "max_volume" integer,
  "max_volume_period" text,
  "changed_by_user_id" uuid,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_funnel_cap_changes_key_changed_at_idx"
  ON "sales_funnel_cap_changes" ("org_id", "brand_id", "offer_id", "sales_funnel_id", "changed_at", "id");
