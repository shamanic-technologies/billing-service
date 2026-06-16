-- Per-brand daily-budget store (per-day spend ceiling / pacing).
-- One row per brand holding the brand's CURRENT daily spend ceiling, upserted
-- in place. This is an allocation / pacing ceiling — a SEPARATE concept from the
-- org credit balance/affordability (unchanged). billing-service stores + serves
-- this value; enforcement (summing today's spend vs the ceiling) is
-- campaign-service's job. Read by GET /internal/brands/:brandId/daily-budget
-- (campaign-service, api-key only), set by PATCH /v1/brands/:brandId/daily-budget
-- (the user, via the gateway). Idempotent: safe to re-run on partial apply.
CREATE TABLE IF NOT EXISTS "brand_daily_budgets" (
  "brand_id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "daily_budget_cents" numeric(16,10) NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
