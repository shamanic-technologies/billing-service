-- Rename credit_ledger -> transactions and unify legacy sources into 'charge'.
-- See migration plan in PR description (investor-page bug, ledger refactor 2026-05-06).
-- This migration is idempotent: re-running on a fully-migrated DB is a no-op.

-- Phase 1: rename table + indexes
ALTER TABLE IF EXISTS "credit_ledger" RENAME TO "transactions";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_credit_ledger_org_id" RENAME TO "idx_transactions_org_id";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_credit_ledger_status" RENAME TO "idx_transactions_status";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_credit_ledger_source" RENAME TO "idx_transactions_source";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_credit_ledger_reload_pi" RENAME TO "idx_transactions_reload_pi";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_credit_ledger_brand_ids" RENAME TO "idx_transactions_brand_ids";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_credit_ledger_promo_org" RENAME TO "idx_transactions_promo_org";--> statement-breakpoint

-- Phase 3: deduct -> charge (direct deductions are now charges in canonical schema)
UPDATE "transactions" SET source = 'charge' WHERE source = 'deduct';--> statement-breakpoint

-- Phase 4 (pre-check): every provision_cancel must pair with a cancelled-debit parent of the same amount.
-- If the data does not match, abort — orphans need human investigation rather than silent drop.
DO $$
DECLARE orphan_count int;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM "transactions" pc
  WHERE pc.source = 'provision_cancel'
    AND NOT EXISTS (
      SELECT 1 FROM "transactions" p
      WHERE p.id::text = substring(pc.description from 'Provision ([0-9a-f-]+)')
        AND p.status = 'cancelled'
        AND p.amount_cents = pc.amount_cents
        AND p.type = 'debit'
    );
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'provision_cancel orphans: % rows. Aborting migration.', orphan_count;
  END IF;
END $$;--> statement-breakpoint

-- Phase 4: drop provision_cancel credit miroirs (the parent debit row is already 'cancelled' which neutralises the balance)
DELETE FROM "transactions" WHERE source = 'provision_cancel';--> statement-breakpoint

-- Phase 5 (pre-check): every provision_adjust must reference an existing parent provision row.
DO $$
DECLARE orphan_count int;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM "transactions" a
  WHERE a.source = 'provision_adjust'
    AND NOT EXISTS (
      SELECT 1 FROM "transactions" p
      WHERE p.id::text = substring(a.description from 'Provision ([0-9a-f-]+)')
        AND p.source = 'provision'
    );
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'provision_adjust orphans: % rows. Aborting migration.', orphan_count;
  END IF;
END $$;--> statement-breakpoint

-- Phase 5 step A: for each provision_adjust, insert a new confirmed debit row that represents the actual
-- final amount $Y (= the parent's current amount_cents). This becomes the canonical 'charge' row after Phase 6.
-- Carries org/user/run/workflow context from the parent so analytics keep working.
INSERT INTO "transactions" (org_id, user_id, run_id, type, amount_cents, status, source, description, campaign_id, brand_ids, workflow_slug, feature_slug, created_at, updated_at)
SELECT
  p.org_id,
  p.user_id,
  p.run_id,
  'debit',
  p.amount_cents,
  'confirmed',
  'provision',
  COALESCE(p.description, '') || ' (post-confirm $Y from collapsed adjust ' || a.id::text || ')',
  p.campaign_id,
  p.brand_ids,
  p.workflow_slug,
  p.feature_slug,
  NOW(),
  NOW()
FROM "transactions" a
JOIN "transactions" p
  ON p.id::text = substring(a.description from 'Provision ([0-9a-f-]+)')
WHERE a.source = 'provision_adjust'
  AND p.source = 'provision';--> statement-breakpoint

-- Phase 5 step B: restore parent provision back to its original amount $X and mark it cancelled.
-- $X is recovered from $Y_current and the signed adjustment delta carried in the adjust row.
UPDATE "transactions" p SET
  amount_cents = CASE
    WHEN a.type = 'credit' THEN p.amount_cents + a.amount_cents
    ELSE p.amount_cents - a.amount_cents
  END,
  status = 'cancelled',
  updated_at = NOW()
FROM "transactions" a
WHERE a.source = 'provision_adjust'
  AND p.id::text = substring(a.description from 'Provision ([0-9a-f-]+)')
  AND p.source = 'provision'
  AND p.status = 'confirmed';--> statement-breakpoint

-- Phase 5 step C: drop the now-redundant adjust rows.
DELETE FROM "transactions" WHERE source = 'provision_adjust';--> statement-breakpoint

-- Phase 6: collapse the remaining 'provision' rows into the unified 'charge' source.
UPDATE "transactions" SET source = 'charge' WHERE source = 'provision';--> statement-breakpoint

-- Phase 7: invariant — only canonical sources remain.
DO $$
DECLARE bad_count int;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM "transactions"
  WHERE source NOT IN ('reload', 'welcome', 'promo', 'charge', 'refund');
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Migration left % rows with non-canonical source', bad_count;
  END IF;
END $$;
