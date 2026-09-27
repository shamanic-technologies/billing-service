-- A brand transfer moves HISTORY, not MONEY.
--
-- When a brand moves from one org to another (POST /internal/transfer-brand),
-- runs-service moves the brand's cost rows to the target org. billing reads each
-- org's usage from those rows, so without a correction the target would suddenly
-- owe the spend the source already paid for, and the source would be freed of it.
--
-- One row per (source org, source brand, target org): what runs-service reported
-- it moved, in the two figures billing subtracts — the net PROJECTED usage
-- (platform actual + provisioned, what the spendable balance subtracts) and the
-- net ACTUALIZED usage (what the displayed balance subtracts). Balance composition
-- adds these back to the source and takes them off the target, so both orgs read
-- exactly the balance they read before. Nothing is written to local_promos: the
-- correction is not a credit and must not reach any gift / welcome logic.
--
-- The row is the audit trail: which brand, from which org to which org, when, and
-- how much. Re-running a transfer overwrites the moved figures with runs-service's
-- cumulative answer (a no-op when nothing more moved).
--
-- Idempotent — safe to re-run. Reverse: DROP TABLE IF EXISTS brand_transfers;
CREATE TABLE IF NOT EXISTS "brand_transfers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_org_id" uuid NOT NULL,
  "source_brand_id" uuid NOT NULL,
  "target_org_id" uuid NOT NULL,
  "target_brand_id" uuid,
  "moved_usage_net_cents" numeric(16, 10) NOT NULL,
  "moved_actual_net_cents" numeric(16, 10) NOT NULL,
  "transferred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "brand_transfers_source_target_key" UNIQUE ("source_org_id", "source_brand_id", "target_org_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_brand_transfers_source_org" ON "brand_transfers" ("source_org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_brand_transfers_target_org" ON "brand_transfers" ("target_org_id");
