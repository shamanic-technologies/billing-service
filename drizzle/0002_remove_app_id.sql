-- Delete duplicate rows per org_id, keeping only the newest account
DELETE FROM "billing_accounts"
WHERE "id" NOT IN (
  SELECT DISTINCT ON ("org_id") "id"
  FROM "billing_accounts"
  ORDER BY "org_id", "created_at" DESC
);--> statement-breakpoint
DROP INDEX IF EXISTS "idx_billing_accounts_org_app";--> statement-breakpoint
ALTER TABLE "billing_accounts" DROP COLUMN IF EXISTS "app_id";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_billing_accounts_org_id" ON "billing_accounts" USING btree ("org_id");
