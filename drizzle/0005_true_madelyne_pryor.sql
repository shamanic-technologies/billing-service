ALTER TABLE "credit_provisions" ADD COLUMN "feature_slug" text;--> statement-breakpoint
ALTER TABLE "billing_accounts" DROP COLUMN IF EXISTS "billing_mode";