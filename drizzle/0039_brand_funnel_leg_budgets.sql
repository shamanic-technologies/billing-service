-- A daily ceiling per (org, brand, sales funnel, acquisition channel, offer, LEG).
--
-- A sales funnel is a chain of steps, and the thing a customer BUYS is one of
-- its LEGS: the leg that takes a lead sitting at one step and moves it to the
-- next. A campaign has been redefined as (brand, offer, acquisition channel,
-- leg) — features-service mints the leg's canonical identifier (its
-- `lib/funnel-legs.ts`, published on `GET /public/channels` as `legs[].legKey`)
-- and campaign-service already carries it on the campaign row. This ceiling was
-- still keyed with the sales funnel and nothing below it, so a campaign and the
-- money that paces it were keyed on two different things.
--
-- ONE LEG BELONGS TO SEVERAL FUNNELS (a booked meeting becomes an attended
-- meeting in both meeting funnels), which is why the funnel is becoming a way of
-- READING legs rather than the unit anything is keyed on. This migration is the
-- ADDITIVE half of that move: the leg JOINS the key, the funnel STAYS in it, and
-- a LATER migration removes the funnel once every consumer has moved. Removing
-- it here would break production.
--
-- THE IDENTIFIER IS features-service's AND IT IS OPAQUE. This column carries
-- that string and nothing else: no leg vocabulary, enum or list exists in
-- billing and none is introduced, exactly as for the acquisition channel (a
-- feature slug) and the offer (a brand-service UUID). It is never PARSED — the
-- two steps a leg connects ride BESIDE the identifier on features-service's
-- catalogue (`fromStep` / `toStep`), so a consumer that wants them reads them
-- there. Splitting the string is how a second, drifting vocabulary starts.
-- `text`, not uuid, because that is the shape features-service mints.
--
-- PURELY ADDITIVE, AND THERE IS NO BACKFILL. `leg_key` is NULLABLE and every
-- existing row keeps NULL, which is a first-class, permanent value here: "this
-- ceiling is not scoped to a leg". It is not a placeholder waiting to be filled.
-- Only the customer knows which leg a live ceiling is for — a funnel has several
-- and a leg belongs to several funnels, so nothing here can derive one — and
-- guessing would move real money onto the wrong campaign. That is the same
-- refusal 0035 made for splitting a brand scalar across funnels and 0037 made
-- for attributing an offer. So no amount, no timestamp and no funnel / channel /
-- offer attribution moves by anything at all: this migration adds a column and
-- re-shapes a key.
--
-- READS ARE UNCHANGED. The brand-wide figure, the per-funnel figure, the
-- per-channel figure (0036) and the per-offer figure (0037) are all still sums
-- of what sits underneath — the per-offer one becomes a sum too. No consumer
-- re-composes any of them, and a brand that has never stated a leg renders
-- byte-identically to what this service served before this migration.
--
-- PRECEDENCE, WHERE BOTH DESCRIBE THE SAME MONEY. A ceiling that NAMES a leg,
-- written onto a (funnel, channel, offer) triple whose SOLE stored ceiling is
-- the leg-less one, REPLACES that ceiling rather than sitting beside it: the
-- customer is re-stating the one ceiling that triple was funded at, and the
-- per-funnel figure is a SUM, so two rows would count their money twice. That is
-- migration 0038's rule one grain down, and it lives in the service layer
-- (`supersededLegLessRows`) exactly as 0038's does.
--
-- WHY THE KEY STAYS A UNIQUE CONSTRAINT. It already is one (0037): a primary key
-- cannot contain a nullable column, and NULL is a real value here rather than an
-- absence to be backfilled. `UNIQUE NULLS NOT DISTINCT` (Postgres 15+; the fleet
-- runs 17 and CI runs 16) makes two leg-less ceilings for one (funnel, channel,
-- offer) triple unrepresentable, exactly as the five-column key did, while
-- letting a leg-scoped row sit beside them. ON CONFLICT inference on the same
-- six columns resolves to it.
--
-- REVERSIBLE. Before any brand funds a leg, one row per (funnel, channel, offer)
-- is exactly what this table held, so the reverse is a column drop:
--
--   -- collapse any leg split back onto one row per (funnel, channel, offer)
--   -- (no-op until a customer funds a leg), then drop the leg from the key:
--   BEGIN;
--   CREATE TEMP TABLE _collapsed AS
--     SELECT org_id, brand_id, funnel_key, feature_slug, offer_id,
--            SUM(daily_budget_cents) AS daily_budget_cents,
--            MAX(updated_at) AS updated_at
--       FROM brand_funnel_daily_budgets GROUP BY 1,2,3,4,5;
--   DELETE FROM brand_funnel_daily_budgets;
--   ALTER TABLE brand_funnel_daily_budgets
--     DROP CONSTRAINT IF EXISTS brand_funnel_daily_budgets_leg_key,
--     DROP COLUMN leg_key,
--     ADD CONSTRAINT brand_funnel_daily_budgets_offer_key
--       UNIQUE NULLS NOT DISTINCT (org_id, brand_id, funnel_key, feature_slug, offer_id);
--   INSERT INTO brand_funnel_daily_budgets
--     (org_id, brand_id, funnel_key, feature_slug, offer_id, daily_budget_cents, updated_at)
--     SELECT org_id, brand_id, funnel_key, feature_slug, offer_id, daily_budget_cents, updated_at
--       FROM _collapsed;
--   COMMIT;
--
-- Idempotent: every statement is guarded, so a re-apply touches nothing.

-- 1. The leg, nullable forever. NULL = "not scoped to a leg".
ALTER TABLE "brand_funnel_daily_budgets"
  ADD COLUMN IF NOT EXISTS "leg_key" text;

-- 2. The key gains it, replacing the five-column one from 0037. Same NULLS NOT
--    DISTINCT semantics, one column wider.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE c.conname = 'brand_funnel_daily_budgets_leg_key'
       AND t.relname = 'brand_funnel_daily_budgets'
  ) THEN
    ALTER TABLE "brand_funnel_daily_budgets"
      ADD CONSTRAINT "brand_funnel_daily_budgets_leg_key"
      UNIQUE NULLS NOT DISTINCT
      ("org_id", "brand_id", "funnel_key", "feature_slug", "offer_id", "leg_key");
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE c.conname = 'brand_funnel_daily_budgets_offer_key'
       AND t.relname = 'brand_funnel_daily_budgets'
  ) THEN
    ALTER TABLE "brand_funnel_daily_budgets"
      DROP CONSTRAINT "brand_funnel_daily_budgets_offer_key";
  END IF;
END $$;

-- The per-OFFER read groups by (org, brand, funnel, channel, offer) now that
-- several rows can share one triple.
CREATE INDEX IF NOT EXISTS "brand_funnel_daily_budgets_org_brand_funnel_channel_offer_idx"
  ON "brand_funnel_daily_budgets" ("org_id", "brand_id", "funnel_key", "feature_slug", "offer_id");
