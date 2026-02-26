CREATE TABLE IF NOT EXISTS "billing_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"stripe_customer_id" text,
	"billing_mode" text DEFAULT 'trial' NOT NULL,
	"credit_balance_cents" integer DEFAULT 200 NOT NULL,
	"reload_amount_cents" integer,
	"reload_threshold_cents" integer DEFAULT 200,
	"stripe_payment_method_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_billing_accounts_org_id" ON "billing_accounts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_accounts_stripe_customer" ON "billing_accounts" USING btree ("stripe_customer_id");