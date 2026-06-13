-- 0020_episode_credited_at_open
-- Out-of-credit dunning: record the org's `credited` snapshot at episode open so
-- the scheduler can detect recovery by a REAL recharge (credited increased) instead
-- of by balance > 0. Balance flutters around zero from provisioned-cost churn
-- (usage includes provisioned holds), which false-closed episodes and re-armed a
-- fresh T0 email each oscillation — customers got duplicate "out of credit" emails.
-- `credited` only ever increases on a paid topup / promo, so it never flutters.
-- Nullable: rows opened before this migration are lazily backfilled on the next
-- scheduler tick (baseline = current credited, no recovery that tick).
ALTER TABLE "credit_depletion_episodes"
  ADD COLUMN IF NOT EXISTS "credited_cents_at_open" numeric(16,10);
