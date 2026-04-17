import { beforeAll, afterAll } from "vitest";

process.env.BILLING_SERVICE_DATABASE_URL =
  process.env.BILLING_SERVICE_DATABASE_URL ||
  "postgresql://test:test@localhost/test";
process.env.BILLING_SERVICE_API_KEY = "test-api-key";
process.env.KEY_SERVICE_URL = "http://localhost:9999";
process.env.KEY_SERVICE_API_KEY = "test-key-service-key";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fake";
process.env.COSTS_SERVICE_URL = "http://localhost:9998";
process.env.COSTS_SERVICE_API_KEY = "test-costs-service-key";
process.env.NODE_ENV = "test";

beforeAll(async () => {
  console.log("Test suite starting...");

  // Ensure credit_provisions table exists (migration may not have run on test DB)
  const { sql } = await import("../src/db/index.js");
  await sql`
    CREATE TABLE IF NOT EXISTS "credit_provisions" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "org_id" uuid NOT NULL,
      "user_id" uuid NOT NULL,
      "run_id" uuid,
      "amount_cents" integer NOT NULL,
      "status" text DEFAULT 'pending' NOT NULL,
      "description" text,
      "campaign_id" text,
      "brand_ids" text[],
      "workflow_slug" text,
      "feature_slug" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS "idx_credit_provisions_org_id" ON "credit_provisions" USING btree ("org_id")`;
  await sql`CREATE INDEX IF NOT EXISTS "idx_credit_provisions_status" ON "credit_provisions" USING btree ("status")`;

  // Add feature_slug column if it doesn't exist (migration 0005)
  await sql`ALTER TABLE "credit_provisions" ADD COLUMN IF NOT EXISTS "feature_slug" text`;

  // Migrate brand_id → brand_ids (migration 0007)
  await sql`ALTER TABLE "credit_provisions" ADD COLUMN IF NOT EXISTS "brand_ids" text[]`;
  await sql`
    DO $$ BEGIN
      UPDATE credit_provisions SET brand_ids = ARRAY[brand_id] WHERE brand_id IS NOT NULL AND brand_ids IS NULL;
      ALTER TABLE credit_provisions DROP COLUMN IF EXISTS brand_id;
    EXCEPTION WHEN undefined_column THEN
      NULL;
    END $$
  `;
  await sql`CREATE INDEX IF NOT EXISTS "idx_credit_provisions_brand_ids" ON "credit_provisions" USING gin ("brand_ids")`;

  // Rename workflow_name → workflow_slug if old column exists (migration 0006)
  await sql`
    DO $$ BEGIN
      ALTER TABLE credit_provisions RENAME COLUMN workflow_name TO workflow_slug;
    EXCEPTION WHEN undefined_column THEN
      NULL;
    END $$
  `;

  // Drop billing_mode column if it still exists (migration 0004)
  await sql`
    DO $$ BEGIN
      ALTER TABLE billing_accounts DROP COLUMN IF EXISTS billing_mode;
    EXCEPTION WHEN undefined_column THEN
      NULL;
    END $$
  `;

  // Add type and stripe_payment_intent_id columns (migration 0008)
  await sql`ALTER TABLE "credit_provisions" ADD COLUMN IF NOT EXISTS "type" text DEFAULT 'debit' NOT NULL`;
  await sql`ALTER TABLE "credit_provisions" ADD COLUMN IF NOT EXISTS "stripe_payment_intent_id" text`;

  // Promo codes tables (migration 0009)
  await sql`
    CREATE TABLE IF NOT EXISTS "promo_codes" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "code" text NOT NULL,
      "amount_cents" integer NOT NULL,
      "max_redemptions" integer,
      "expires_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "idx_promo_codes_code" ON "promo_codes" USING btree ("code")`;
  await sql`
    CREATE TABLE IF NOT EXISTS "promo_redemptions" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "promo_code_id" uuid NOT NULL REFERENCES "promo_codes"("id"),
      "org_id" uuid NOT NULL,
      "user_id" uuid NOT NULL,
      "amount_cents" integer NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "idx_promo_redemptions_org_code" ON "promo_redemptions" USING btree ("promo_code_id", "org_id")`;
  await sql`CREATE INDEX IF NOT EXISTS "idx_promo_redemptions_org_id" ON "promo_redemptions" USING btree ("org_id")`;
});
afterAll(() => console.log("Test suite complete."));
