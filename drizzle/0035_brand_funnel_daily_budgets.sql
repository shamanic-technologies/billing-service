-- Per-funnel daily spending ceilings for a brand.
--
-- brand_daily_budgets holds ONE scalar per (org, brand): everything the brand
-- sells is funded from the same pot. A customer selling both a $200 self-serve
-- plan and a $20k contract cannot say "spend $1/day chasing purchases and
-- $24/day chasing meetings". This table records ONE ceiling per
-- (org, brand, funnel) — the funnel keys are brand-service's own vocabulary
-- (reply_meeting, visit_meeting, visit_signup, visit_form).
--
-- The brand-level read (GET /internal/brands/:brandId/daily-budget) is unchanged
-- in shape and answers the SUM of these rows once any exist, so every existing
-- consumer (launch gate, runway warnings, credit alerts, Overview tile,
-- campaign-service budget propagation) keeps working with no change.
--
-- NO BACKFILL: a brand that has never set per-funnel ceilings keeps its
-- brand_daily_budgets row as the authoritative value. Splitting an existing
-- budget across funnels would invent numbers the customer never stated.
--
-- 0 is a legal, ordinary value: "not funding that funnel right now". A set whose
-- ceilings are ALL zero is a brand in pause, not an error. The per-funnel product
-- minimum applies only to a FUNDED (> 0) funnel and is enforced in the service
-- layer, not by a CHECK constraint — the minimums are product figures that move,
-- and a frozen constraint would reject a re-priced offer.
--
-- Idempotent (IF NOT EXISTS) — safe on the drizzle migrator + the hand-built test
-- schema.
CREATE TABLE IF NOT EXISTS "brand_funnel_daily_budgets" (
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "funnel_key" text NOT NULL,
  "daily_budget_cents" numeric(16,10) NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "brand_funnel_daily_budgets_pkey" PRIMARY KEY ("org_id", "brand_id", "funnel_key")
);

CREATE INDEX IF NOT EXISTS "brand_funnel_daily_budgets_org_brand_idx"
  ON "brand_funnel_daily_budgets" ("org_id", "brand_id");
