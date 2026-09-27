-- Staff debits: a staff member takes credit OFF an org's balance, with a note.
--
-- The mirror of the staff credit grant (admin_grant in local_promos), but kept in
-- its OWN table on purpose. A debit is not a negative gift: local_promos feeds the
-- welcome remainder, the free-credit entitlement, the referral ladder and the
-- "credited_gifted_cents" figure, and a negative row there would reach all of them
-- (a debit would silently ENLARGE a welcome remainder). Balance composition instead
-- adds these rows to the org's USAGE (lib/transfer-usage.ts), so a debit lowers the
-- spendable and the displayed balance exactly like spend does, while credited_cents
-- (the dunning-recovery and card-verdict baseline) does not move.
--
-- One row per debit. (org_id, idempotency_key) is unique so a retried request
-- debits once. Nothing here charges a card.
--
-- Idempotent — safe to re-run. Reverse: DROP TABLE IF EXISTS staff_debits;
CREATE TABLE IF NOT EXISTS "staff_debits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "amount_cents" numeric(16, 10) NOT NULL,
  "note" text NOT NULL,
  "debited_by" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "staff_debits_amount_positive" CHECK ("amount_cents" > 0),
  CONSTRAINT "staff_debits_org_idempotency_key" UNIQUE ("org_id", "idempotency_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_staff_debits_org" ON "staff_debits" ("org_id");
