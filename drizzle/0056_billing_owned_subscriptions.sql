-- SUBSCRIPTION, owned by billing (acquirer-neutral). Replaces reading a Stripe
-- subscription object: the org's card is saved through the ordinary card setup
-- (Revolut by default, Stripe for legacy orgs) and billing charges the monthly
-- amount itself through the acquirer-neutral off-session charge. No subscriber
-- existed when this shipped (0 stamped orgs, 0 trial grants in prod).
--
--   subscriptions                 one row per subscription; at most one non-ended per org
--   subscription_charges          one row per billed period, retried on the reload rungs
--   subscription_credit_expiries  unspent credit expired at a period boundary (usage side)
--   billing_accounts.subscription_requested_amount_cents  the amount chosen at checkout
--
-- Idempotent. Reverse:
--   DROP TABLE IF EXISTS subscription_credit_expiries, subscription_charges, subscriptions;
--   ALTER TABLE billing_accounts DROP COLUMN IF EXISTS subscription_requested_amount_cents;
CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "status" text NOT NULL,
  "monthly_amount_cents" integer NOT NULL,
  "trial_started_at" timestamp with time zone,
  "trial_ends_at" timestamp with time zone,
  "current_period_start" timestamp with time zone NOT NULL,
  "current_period_end" timestamp with time zone NOT NULL,
  "cancel_at_period_end" boolean NOT NULL DEFAULT false,
  "canceled_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "credits_used_notified_period_start" timestamp with time zone,
  "started_by_user_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "subscriptions_status_check" CHECK ("status" IN ('trialing', 'active', 'past_due', 'canceled')),
  CONSTRAINT "subscriptions_amount_check" CHECK ("monthly_amount_cents" >= 9900)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_subscriptions_one_live_per_org" ON "subscriptions" ("org_id") WHERE "status" <> 'canceled';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subscriptions_org" ON "subscriptions" ("org_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_charges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subscription_id" uuid NOT NULL REFERENCES "subscriptions"("id") ON DELETE CASCADE,
  "org_id" uuid NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "amount_cents" integer NOT NULL,
  "status" text NOT NULL,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "first_failed_at" timestamp with time zone,
  "last_attempt_at" timestamp with time zone,
  "paid_at" timestamp with time zone,
  "reference" text,
  "failure_code" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "subscription_charges_status_check" CHECK ("status" IN ('pending', 'paid', 'failed')),
  CONSTRAINT "subscription_charges_period_unique" UNIQUE ("subscription_id", "period_start")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subscription_charges_org" ON "subscription_charges" ("org_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_credit_expiries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "subscription_id" uuid NOT NULL,
  "boundary_at" timestamp with time zone NOT NULL,
  "amount_cents" numeric(16, 10) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "subscription_credit_expiries_amount_check" CHECK ("amount_cents" >= 0),
  CONSTRAINT "subscription_credit_expiries_org_boundary" UNIQUE ("org_id", "boundary_at")
);
--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "subscription_requested_amount_cents" integer;
