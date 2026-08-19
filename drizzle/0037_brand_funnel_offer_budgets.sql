-- A daily ceiling per (org, brand, sales funnel, acquisition channel, OFFER).
--
-- A new granularity sits between Brand and Campaign: an OFFER — one distinct
-- thing a brand sells (its value proposition plus the funnels it sells through).
-- brand-service owns that entity and exposes it as a UUID; billing defines none
-- of its semantics and stores whatever id the customer funds.
--
-- A campaign is now (offer x sales funnel x acquisition channel). Migration 0036
-- keyed the ceiling on (funnel, channel), which was one campaign then and is not
-- one now: two offers of the same brand selling through the same funnel on the
-- same channel would collide on ONE ceiling, so funding one would silently fund
-- the other and neither could be stopped without stopping both. The ceiling
-- therefore gains the offer, and nothing else — after this it addresses exactly
-- one campaign.
--
-- PURELY ADDITIVE, AND THERE IS NO BACKFILL. `offer_id` is NULLABLE and every
-- existing row keeps NULL, which is a first-class, permanent value here: "this
-- ceiling is not scoped to an offer". It is not a placeholder waiting to be
-- filled. Only brand-service knows which offer a live ceiling belongs to, and
-- guessing would move real money onto the wrong campaign — the same reason 0035
-- refused to split a brand-level scalar across funnels. So no amount, no
-- timestamp and no funnel/channel attribution moves by anything at all: this
-- migration adds a column and re-shapes a key.
--
-- READS ARE UNCHANGED. The brand-wide figure and the per-funnel figure are still
-- sums of what sits underneath, and the per-CHANNEL figure (added by 0036) is
-- now a sum too. No consumer re-composes any of them.
--
-- WHY A UNIQUE CONSTRAINT AND NOT A PRIMARY KEY. A primary key cannot contain a
-- nullable column, and NULL is a real value here rather than an absence to be
-- backfilled. `UNIQUE NULLS NOT DISTINCT` (Postgres 15+; the fleet runs 17 and
-- CI runs 16) makes two NULL-offer rows for one (funnel, channel) pair
-- unrepresentable, exactly as the old primary key did, while letting an
-- offer-scoped row sit beside them. ON CONFLICT inference on the same five
-- columns resolves to it.
--
-- REVERSIBLE. Before any brand funds an offer, one row per (funnel, channel) is
-- exactly what this table held, so the reverse is a column drop:
--
--   -- collapse any offer split back onto one row per (funnel, channel) first
--   -- (no-op until a customer funds an offer), then drop the offer from the key:
--   BEGIN;
--   CREATE TEMP TABLE _collapsed AS
--     SELECT org_id, brand_id, funnel_key, feature_slug,
--            SUM(daily_budget_cents) AS daily_budget_cents,
--            MAX(updated_at) AS updated_at
--       FROM brand_funnel_daily_budgets GROUP BY 1,2,3,4;
--   DELETE FROM brand_funnel_daily_budgets;
--   ALTER TABLE brand_funnel_daily_budgets
--     DROP CONSTRAINT IF EXISTS brand_funnel_daily_budgets_offer_key,
--     DROP COLUMN offer_id,
--     ADD CONSTRAINT brand_funnel_daily_budgets_pkey
--       PRIMARY KEY (org_id, brand_id, funnel_key, feature_slug);
--   INSERT INTO brand_funnel_daily_budgets
--     (org_id, brand_id, funnel_key, feature_slug, daily_budget_cents, updated_at)
--     SELECT org_id, brand_id, funnel_key, feature_slug, daily_budget_cents, updated_at
--       FROM _collapsed;
--   COMMIT;
--
-- Idempotent: every statement is guarded, so a re-apply touches nothing.

-- 1. The offer, nullable forever. NULL = "not scoped to an offer".
ALTER TABLE "brand_funnel_daily_budgets"
  ADD COLUMN IF NOT EXISTS "offer_id" uuid;

-- 2. The key gains it. The old 4-column primary key is replaced by a unique
--    constraint over the same columns plus the offer, treating NULLs as equal so
--    a (funnel, channel) pair still cannot hold two unscoped ceilings.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE c.conname = 'brand_funnel_daily_budgets_pkey'
       AND t.relname = 'brand_funnel_daily_budgets'
  ) THEN
    ALTER TABLE "brand_funnel_daily_budgets"
      DROP CONSTRAINT "brand_funnel_daily_budgets_pkey";
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE c.conname = 'brand_funnel_daily_budgets_offer_key'
       AND t.relname = 'brand_funnel_daily_budgets'
  ) THEN
    ALTER TABLE "brand_funnel_daily_budgets"
      ADD CONSTRAINT "brand_funnel_daily_budgets_offer_key"
      UNIQUE NULLS NOT DISTINCT
      ("org_id", "brand_id", "funnel_key", "feature_slug", "offer_id");
  END IF;
END $$;

-- The per-CHANNEL read groups by (org, brand, funnel, channel) now that several
-- rows can share one pair.
CREATE INDEX IF NOT EXISTS "brand_funnel_daily_budgets_org_brand_funnel_channel_idx"
  ON "brand_funnel_daily_budgets" ("org_id", "brand_id", "funnel_key", "feature_slug");
