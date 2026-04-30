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
process.env.RUNS_SERVICE_URL = "http://localhost:9997";
process.env.RUNS_SERVICE_API_KEY = "test-runs-service-key";
process.env.NODE_ENV = "test";

beforeAll(async () => {
  console.log("Test suite starting...");

  const { sql } = await import("../src/db/index.js");

  // Drop billing_mode column if it still exists
  await sql`
    DO $$ BEGIN
      ALTER TABLE billing_accounts DROP COLUMN IF EXISTS billing_mode;
    EXCEPTION WHEN undefined_column THEN
      NULL;
    END $$
  `;

  // Rename promo_codes -> local_promo_codes (if old table exists)
  await sql`
    DO $$ BEGIN
      ALTER TABLE promo_codes RENAME TO local_promo_codes;
    EXCEPTION WHEN undefined_table THEN NULL;
              WHEN duplicate_table THEN NULL;
    END $$
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS "local_promo_codes" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "code" text NOT NULL,
      "amount_cents" integer NOT NULL,
      "max_redemptions" integer,
      "expires_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "idx_local_promo_codes_code" ON "local_promo_codes" USING btree ("code")`;

  // Rename credit_provisions -> credit_ledger (if old table exists)
  await sql`
    DO $$ BEGIN
      ALTER TABLE credit_provisions RENAME TO credit_ledger;
    EXCEPTION WHEN undefined_table THEN NULL;
              WHEN duplicate_table THEN NULL;
    END $$
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS "credit_ledger" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "org_id" uuid NOT NULL,
      "user_id" uuid NOT NULL,
      "run_id" uuid,
      "type" text DEFAULT 'debit' NOT NULL,
      "amount_cents" integer NOT NULL,
      "status" text DEFAULT 'pending' NOT NULL,
      "source" text DEFAULT 'provision' NOT NULL,
      "stripe_payment_intent_id" text,
      "stripe_balance_txn_id" text,
      "promo_code_id" uuid,
      "description" text,
      "campaign_id" text,
      "brand_ids" text[],
      "workflow_slug" text,
      "feature_slug" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;

  // Add new columns if they don't exist (for rename path)
  await sql`ALTER TABLE "credit_ledger" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'provision' NOT NULL`;
  await sql`ALTER TABLE "credit_ledger" ADD COLUMN IF NOT EXISTS "stripe_balance_txn_id" text`;
  await sql`ALTER TABLE "credit_ledger" ADD COLUMN IF NOT EXISTS "promo_code_id" uuid`;
  await sql`ALTER TABLE "credit_ledger" ADD COLUMN IF NOT EXISTS "feature_slug" text`;
  await sql`ALTER TABLE "credit_ledger" ADD COLUMN IF NOT EXISTS "brand_ids" text[]`;
  await sql`ALTER TABLE "credit_ledger" ADD COLUMN IF NOT EXISTS "stripe_payment_intent_id" text`;
  await sql`ALTER TABLE "credit_ledger" ADD COLUMN IF NOT EXISTS "type" text DEFAULT 'debit' NOT NULL`;

  // Indexes
  await sql`CREATE INDEX IF NOT EXISTS "idx_credit_ledger_org_id" ON "credit_ledger" USING btree ("org_id")`;
  await sql`CREATE INDEX IF NOT EXISTS "idx_credit_ledger_status" ON "credit_ledger" USING btree ("status")`;
  await sql`CREATE INDEX IF NOT EXISTS "idx_credit_ledger_source" ON "credit_ledger" USING btree ("source")`;

  // Partial unique index for promo anti-double-redemption
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "idx_credit_ledger_promo_org" ON "credit_ledger" ("promo_code_id", "org_id") WHERE source = 'promo'`;

  // Migrate brand_id -> brand_ids if old column exists
  await sql`
    DO $$ BEGIN
      UPDATE credit_ledger SET brand_ids = ARRAY[brand_id] WHERE brand_id IS NOT NULL AND brand_ids IS NULL;
      ALTER TABLE credit_ledger DROP COLUMN IF EXISTS brand_id;
    EXCEPTION WHEN undefined_column THEN
      NULL;
    END $$
  `;

  // Rename workflow_name -> workflow_slug if old column exists
  await sql`
    DO $$ BEGIN
      ALTER TABLE credit_ledger RENAME COLUMN workflow_name TO workflow_slug;
    EXCEPTION WHEN undefined_column THEN
      NULL;
    END $$
  `;

  // Drop promo_redemptions table (data migrated to credit_ledger)
  await sql`DROP TABLE IF EXISTS "promo_redemptions"`;
});
afterAll(() => console.log("Test suite complete."));
