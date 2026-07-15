-- Append-only history of per-(org, brand) daily-budget changes.
--
-- brand_daily_budgets holds ONLY the CURRENT scalar (upserted in place), so the
-- timeline of raises / lowers / zeroings is lost. This table records ONE row per
-- write: the value the budget BECAME and WHEN. Forward-only — past changes were
-- never captured, so there is no backfill (a fabricated history would be wrong).
--
-- Written in the SAME transaction as the brand_daily_budgets upsert (so a change
-- is never stored without its history entry), read by
-- GET /internal/brands/:brandId/daily-budget/history (features-service customer
-- health board). billing-service only STORES + SERVES this; the current-value
-- read (GET .../daily-budget) is unchanged.
--
-- id is a monotonically-increasing surrogate: it gives a stable secondary sort
-- so two writes in the same millisecond keep insertion order. Idempotent
-- (IF NOT EXISTS) — safe to re-run on the drizzle migrator + the hand-built test
-- schema.
CREATE TABLE IF NOT EXISTS "brand_daily_budget_changes" (
  "id" bigserial PRIMARY KEY,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "daily_budget_cents" numeric(16,10) NOT NULL,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "brand_daily_budget_changes_org_brand_changed_at_idx"
  ON "brand_daily_budget_changes" ("org_id", "brand_id", "changed_at", "id");
