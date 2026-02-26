DROP INDEX IF EXISTS "idx_billing_accounts_org_id";--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "app_id" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_billing_accounts_org_app" ON "billing_accounts" USING btree ("org_id","app_id");