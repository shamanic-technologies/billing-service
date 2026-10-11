-- OFF-PLATFORM PAYMENTS (owner 2026-10-11): « revenue is cash the client paid ». A
-- client who pays the owner directly (bank transfer) is credited by a staff
-- admin_grant, which billing counted as a GIFT, so the client read as never paying
-- (Olive: $200 received by Kevin, cash 0). One row here marks ONE admin_grant row as
-- money the client PAID on `paid_at`: it then counts in cash_paid_cents (and in
-- cash_by_month at paid_at), out of credited_gifted_cents. The credit itself stays
-- the local_promos row, so the balance is unchanged (no double credit).
--
-- Append-only and traceable: the grant row is never edited; `recorded_by` / `note`
-- / `created_at` say who marked it, why and when (a later reclassification of an
-- existing grant is a row written NOW about a grant created earlier).
--
-- Writes no rows. Idempotent. Reverse: DROP TABLE off_platform_payments;
CREATE TABLE IF NOT EXISTS "off_platform_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "local_promo_id" uuid NOT NULL REFERENCES "local_promos"("id") ON DELETE CASCADE,
  "org_id" uuid NOT NULL,
  "paid_at" timestamp with time zone NOT NULL,
  "recorded_by" text,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "off_platform_payments_local_promo_unique" UNIQUE ("local_promo_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_off_platform_payments_org" ON "off_platform_payments" ("org_id");
