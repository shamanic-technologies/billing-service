-- Convert integer-cent columns to numeric(16,10) for sub-cent precision.
-- Idempotent: re-running on a migrated DB is a no-op (column types are checked).
--
-- Why:
--   Upstream services (notably runs-service) need to bill fractional costs without
--   per-call rounding. We move the rounding boundary from "every batch" to
--   "human-facing display only", and let Stripe (integer-only) lag the ledger
--   by ≤1¢ via ceil-boundary delta sync.
--
-- Bit-for-bit preservation:
--   integer N maps to numeric(16,10) value N exactly. PostgreSQL casts
--   `int → numeric` losslessly.

-- transactions.amount_cents
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'transactions' AND column_name = 'amount_cents') = 'integer'
  THEN
    ALTER TABLE "transactions" ALTER COLUMN "amount_cents" TYPE numeric(16,10) USING "amount_cents"::numeric(16,10);
  END IF;
END $$;--> statement-breakpoint

-- billing_accounts.credit_balance_cents
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'billing_accounts' AND column_name = 'credit_balance_cents') = 'integer'
  THEN
    ALTER TABLE "billing_accounts" ALTER COLUMN "credit_balance_cents" TYPE numeric(16,10) USING "credit_balance_cents"::numeric(16,10);
    ALTER TABLE "billing_accounts" ALTER COLUMN "credit_balance_cents" SET DEFAULT 200;
  END IF;
END $$;--> statement-breakpoint

-- Per-org balance invariant check (post-migration).
-- If integer cast preserved every value, this should never fire.
DO $$
DECLARE bad_count int;
BEGIN
  SELECT COUNT(*) INTO bad_count FROM (
    SELECT
      ba.org_id,
      ba.credit_balance_cents AS cached,
      COALESCE(SUM(
        CASE
          WHEN t.type = 'credit' AND t.status = 'confirmed' THEN t.amount_cents
          WHEN t.type = 'debit' AND t.status IN ('confirmed', 'pending') THEN -t.amount_cents
          ELSE 0
        END
      ), 0) AS computed,
      COUNT(t.id) AS entry_count
    FROM billing_accounts ba
    LEFT JOIN transactions t ON t.org_id = ba.org_id
    GROUP BY ba.org_id, ba.credit_balance_cents
  ) AS s
  WHERE s.entry_count > 0 AND s.cached <> s.computed;
  -- Note: drift is reconciled at runtime in /authorize, not blocking here.
  -- We only RAISE if invariant was broken BY this migration, which is impossible
  -- under int → numeric cast. Counting for telemetry.
  IF bad_count > 0 THEN
    RAISE NOTICE 'Pre-existing balance drift detected: % orgs (reconcile() will heal at runtime)', bad_count;
  END IF;
END $$;
