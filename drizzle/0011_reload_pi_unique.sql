-- Unique partial index to prevent duplicate reload ledger entries for the same Stripe payment intent.
-- Without this, concurrent reconcile runs can each insert a row for the same PI (and double-bump the cache).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_credit_ledger_reload_pi" ON "credit_ledger" ("org_id", "stripe_payment_intent_id") WHERE source = 'reload' AND stripe_payment_intent_id IS NOT NULL;
