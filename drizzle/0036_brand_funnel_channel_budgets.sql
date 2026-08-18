-- A daily ceiling per (org, brand, sales funnel, ACQUISITION-CHANNEL FEATURE).
--
-- Until now a brand funded one ceiling per SALES FUNNEL, and campaign-service ran
-- one campaign per funded funnel. The same funnel can now be worked through TWO
-- different offers at once (a straight sales pitch and a feedback-request pitch),
-- each its own campaign, measured on its own. A channel IS a features-service
-- feature slug — there is no separate "channel" concept, here or anywhere in the
-- fleet — so the ceiling gains that slug and nothing else.
--
-- READS ARE UNCHANGED. GET /internal/brands/:brandId/daily-budget still answers
-- the brand-wide figure and the per-funnel view still answers one figure per
-- funnel; both are now SUMS of the rows underneath. No consumer re-composes a
-- sum itself.
--
-- THE BACKFILL NAMES THE CHANNEL EACH BRAND ACTUALLY RUNS. Two sales features
-- exist in production (`sales-cold-email-outreach`, `sales-crm-email-outreach`),
-- so a blanket assignment to one of them would be wrong. Every live ceiling was
-- matched against campaign-service's own campaigns (org_id, brand_id, funnel_key
-- -> feature_slug) on 2026-08-18:
--
--   19 ceilings, 17 of them resolved by an existing campaign:
--     * 16 run `sales-cold-email-outreach`
--     * 1 runs `sales-crm-email-outreach`
--       (org b645207b-…, brand ccc29ba2-…, funnel visit_signup / website_purchases)
--   The remaining 2 (org 19e57690-… brand 6875c68e-… reply_meeting;
--   org 35f259d0-… brand 51aa330c-… visit_signup) have never had a campaign of
--   any kind, so there is no channel to read off. They take the platform's
--   default sales channel, which is also the only channel every other brand in
--   the fleet has ever run for a funnel.
--
-- So: name the CRM exception explicitly, and let everything else — the 16
-- verified cold rows, the 2 channel-less rows, and any row written by the old
-- code between this snapshot and the deploy — land on the default. What a brand
-- is ALLOWED TO SPEND does not move by a cent either way: the ceiling value is
-- untouched and the funnel total is the same single row it was.
--
-- REVERSIBLE. Before any brand splits a funnel, one row per funnel is exactly
-- what this table held, so the reverse is a column drop:
--
--   -- collapse any split back onto one row per funnel first (no-op until a
--   -- customer splits one), then drop the channel from the key:
--   BEGIN;
--   CREATE TEMP TABLE _collapsed AS
--     SELECT org_id, brand_id, funnel_key,
--            SUM(daily_budget_cents) AS daily_budget_cents,
--            MAX(updated_at) AS updated_at
--       FROM brand_funnel_daily_budgets GROUP BY 1,2,3;
--   DELETE FROM brand_funnel_daily_budgets;
--   ALTER TABLE brand_funnel_daily_budgets
--     DROP CONSTRAINT brand_funnel_daily_budgets_pkey,
--     DROP COLUMN feature_slug,
--     ADD CONSTRAINT brand_funnel_daily_budgets_pkey PRIMARY KEY (org_id, brand_id, funnel_key);
--   INSERT INTO brand_funnel_daily_budgets SELECT * FROM _collapsed;
--   COMMIT;
--
-- Idempotent: every statement is guarded, so a re-apply touches nothing.

-- 1. The column, nullable at first so existing rows survive the ADD.
ALTER TABLE "brand_funnel_daily_budgets"
  ADD COLUMN IF NOT EXISTS "feature_slug" text;

-- 2. The one verified CRM ceiling.
UPDATE "brand_funnel_daily_budgets"
   SET "feature_slug" = 'sales-crm-email-outreach'
 WHERE "feature_slug" IS NULL
   AND "org_id" = 'b645207b-d8e9-40b0-9391-072b777cd9a9'
   AND "brand_id" = 'ccc29ba2-78ce-48fc-a57c-16c4fa0e1449'
   AND "funnel_key" = 'visit_signup';

-- 3. Everything else runs the default sales channel (verified above).
UPDATE "brand_funnel_daily_budgets"
   SET "feature_slug" = 'sales-cold-email-outreach'
 WHERE "feature_slug" IS NULL;

-- 4. Now it can be required, and it joins the key.
ALTER TABLE "brand_funnel_daily_budgets"
  ALTER COLUMN "feature_slug" SET NOT NULL;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE c.conname = 'brand_funnel_daily_budgets_pkey'
       AND t.relname = 'brand_funnel_daily_budgets'
       AND array_length(c.conkey, 1) = 3
  ) THEN
    ALTER TABLE "brand_funnel_daily_budgets"
      DROP CONSTRAINT "brand_funnel_daily_budgets_pkey";
    ALTER TABLE "brand_funnel_daily_budgets"
      ADD CONSTRAINT "brand_funnel_daily_budgets_pkey"
      PRIMARY KEY ("org_id", "brand_id", "funnel_key", "feature_slug");
  END IF;
END $$;

-- The per-funnel read groups by (org, brand, funnel) now that several rows can
-- share one funnel.
CREATE INDEX IF NOT EXISTS "brand_funnel_daily_budgets_org_brand_funnel_idx"
  ON "brand_funnel_daily_budgets" ("org_id", "brand_id", "funnel_key");
