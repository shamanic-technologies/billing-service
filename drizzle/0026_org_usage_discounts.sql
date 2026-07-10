-- Per-org usage discount (staff-managed platform-usage discount).
--
-- A discounted org effectively pays (1 - discount_pct/100) of its GROSS platform
-- usage: the usage component billing subtracts at balance composition is reduced
-- by discount_pct, so the spendable balance depletes proportionally slower and
-- Stripe topups fire proportionally less often. The GROSS usage in runs-service
-- is untouched (reporting still sees the full number).
--
-- ONE value per org (org_id PRIMARY KEY), replaceable (upsert) and removable
-- (DELETE row -> null -> no discount = today's exact behavior). granted audit:
-- set_by (staff email) + set_at.
--
-- Nullable-by-absence: no row = no discount. A CHECK enforces 0..100 at the DB
-- level (fail loud; the route also validates, no silent clamp).
--
-- Idempotent -- safe to re-run (drizzle migrator + the hand-built test schema).

CREATE TABLE IF NOT EXISTS "org_usage_discounts" (
  "org_id" uuid PRIMARY KEY,
  "discount_pct" integer NOT NULL,
  "set_by" text,
  "set_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "org_usage_discount_pct_range" CHECK ("discount_pct" >= 0 AND "discount_pct" <= 100)
);
