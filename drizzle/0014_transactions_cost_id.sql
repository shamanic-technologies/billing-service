-- Add cost_id natural key to transactions.
--
-- Why:
--   Decouples runs-service callers from billing-internal transaction ids.
--   runs-service issues one provision per cost row carrying its `cost_id`
--   (= runs_costs.id). Confirm/cancel webhooks reference the same `cost_id`
--   instead of the billing-side provision_id, fixing a class of 409s where
--   one runs-service provision was reused for N cost rows.
--
-- Non-unique:
--   The same cost_id may appear multiple times across history
--   (pending → cancelled, then a fresh confirmed row at a different amount).
--   Only one row per cost_id is in non-terminal state at any moment.

ALTER TABLE "transactions" ADD COLUMN "cost_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_transactions_cost_id" ON "transactions" USING btree ("cost_id");
