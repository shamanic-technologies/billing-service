-- Scope brand daily budgets by org as well as brand.
-- Existing rows are preserved under their recorded org_id. The migration does
-- not copy a brand's budget to other orgs because that would silently duplicate
-- spend caps without provenance.
ALTER TABLE "brand_daily_budgets"
  DROP CONSTRAINT IF EXISTS "brand_daily_budgets_pkey";

ALTER TABLE "brand_daily_budgets"
  ADD CONSTRAINT "brand_daily_budgets_pkey"
  PRIMARY KEY ("org_id", "brand_id");
