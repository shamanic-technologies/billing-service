-- A funnel cap stores its funnel's TYPE (features-service's served `type`), read
-- at write, so the daily figures that must count a REACTIVE funnel's "Up to $X"
-- as 0 (owner rule 2026-10-01: a reactive budget is a ceiling, never daily
-- spend / pace / MRR) can tell it apart without a network read on the hot path.
-- NULL = not known yet (a row written before this, or features-service serving
-- no type): billing's boot backfill reads it. No row is rewritten here.
--
-- Idempotent. Reverse: ALTER TABLE sales_funnel_caps DROP COLUMN sales_funnel_type;
ALTER TABLE "sales_funnel_caps" ADD COLUMN IF NOT EXISTS "sales_funnel_type" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sales_funnel_caps" ADD CONSTRAINT "sales_funnel_caps_type" CHECK ("sales_funnel_type" IN ('proactive', 'reactive'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
