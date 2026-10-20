-- POSTPAID has no auto top-up (owner 2026-10-21: « l'autotopup n'a aucun sens en
-- post paid et ne devrait pas exister »). Nothing is stored for a postpaid org: its
-- credit line exists whenever a chargeable card does (lib/topup-tier autoTopupArmed),
-- so these values were already ignored since v0.83.47. Prod at ship time: 18 rows.
-- Idempotent: a re-apply finds nothing to clear.
UPDATE billing_accounts
SET topup_amount_cents = NULL, topup_threshold_cents = NULL, updated_at = now()
WHERE payment_mode = 'postpaid'
  AND (topup_amount_cents IS NOT NULL OR topup_threshold_cents IS NOT NULL);
