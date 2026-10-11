-- AUTO-UPGRADE (owner 2026-10-11): when a subscriber's credit runs out, the plan
-- moves up one step (+$100/month) and the step is charged at once, credit lands.
-- Statement ORDER is the grandfather (same trick as 0032): ADD COLUMN ... DEFAULT
-- false stamps every EXISTING subscription as NOT auto-upgrading (prod: one live
-- plan, org fc600ac6-…, keeps today's behaviour), THEN SET DEFAULT true aims every
-- subscription created after this deploy at the new rule. On a re-apply ADD COLUMN
-- IF NOT EXISTS is a no-op, so a new plan can never be re-stamped false.
--
-- Idempotent. Reverse: ALTER TABLE subscriptions DROP COLUMN auto_upgrade;
--   DROP TABLE subscription_auto_upgrades; DROP TABLE payment_consents;
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "auto_upgrade" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "auto_upgrade" SET DEFAULT true;
--> statement-breakpoint
-- One row per auto-upgrade attempt. `pending` = claimed, charge in flight; the
-- partial unique index makes at most ONE in flight per plan (two racing triggers
-- cannot both charge).
CREATE TABLE IF NOT EXISTS "subscription_auto_upgrades" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subscription_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "from_amount_cents" integer NOT NULL,
  "to_amount_cents" integer NOT NULL,
  "charged_cents" integer NOT NULL,
  "status" text NOT NULL,
  "reference" text,
  "failure_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp with time zone,
  CONSTRAINT "subscription_auto_upgrades_status" CHECK ("status" IN ('pending', 'paid', 'declined'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_subscription_auto_upgrades_one_pending"
  ON "subscription_auto_upgrades" ("subscription_id") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subscription_auto_upgrades_org" ON "subscription_auto_upgrades" ("org_id");
--> statement-breakpoint
-- Proof that the customer ticked the consent boxes before a first payment (owner
-- 2026-10-11): append-only, one row per acceptance. Kept on org teardown on
-- purpose: it is dispute / chargeback evidence.
CREATE TABLE IF NOT EXISTS "payment_consents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "user_id" uuid,
  "email" text,
  "context" text NOT NULL,
  "statements" jsonb NOT NULL,
  "terms_version" text NOT NULL,
  "accepted_at" timestamp with time zone NOT NULL,
  "user_agent" text,
  "ip_address" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_consents_org" ON "payment_consents" ("org_id");
