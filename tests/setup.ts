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

  // billing_accounts cleanup from earlier schemas
  await sql`
    DO $$ BEGIN
      ALTER TABLE billing_accounts DROP COLUMN IF EXISTS billing_mode;
    EXCEPTION WHEN undefined_column THEN
      NULL;
    END $$
  `;

  // local_promo_codes (renamed from promo_codes in 0010)
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

  // Walk the table-rename history: credit_provisions -> credit_ledger -> transactions.
  await sql`
    DO $$ BEGIN
      ALTER TABLE credit_provisions RENAME TO credit_ledger;
    EXCEPTION WHEN undefined_table THEN NULL;
              WHEN duplicate_table THEN NULL;
    END $$
  `;
  await sql`
    DO $$ BEGIN
      ALTER TABLE credit_ledger RENAME TO transactions;
    EXCEPTION WHEN undefined_table THEN NULL;
              WHEN duplicate_table THEN NULL;
    END $$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS "transactions" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "org_id" uuid NOT NULL,
      "user_id" uuid NOT NULL,
      "run_id" uuid,
      "type" text DEFAULT 'debit' NOT NULL,
      "amount_cents" integer NOT NULL,
      "status" text DEFAULT 'pending' NOT NULL,
      "source" text DEFAULT 'charge' NOT NULL,
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

  // Add columns if missing (rename path keeps existing columns; this fills gaps).
  await sql`ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'charge' NOT NULL`;
  await sql`ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "stripe_balance_txn_id" text`;
  await sql`ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "promo_code_id" uuid`;
  await sql`ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "feature_slug" text`;
  await sql`ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "brand_ids" text[]`;
  await sql`ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "stripe_payment_intent_id" text`;
  await sql`ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "type" text DEFAULT 'debit' NOT NULL`;

  // Renamed indexes (rename path) + create-if-missing (fresh DB path).
  await sql`ALTER INDEX IF EXISTS "idx_credit_ledger_org_id" RENAME TO "idx_transactions_org_id"`;
  await sql`ALTER INDEX IF EXISTS "idx_credit_ledger_status" RENAME TO "idx_transactions_status"`;
  await sql`ALTER INDEX IF EXISTS "idx_credit_ledger_source" RENAME TO "idx_transactions_source"`;
  await sql`ALTER INDEX IF EXISTS "idx_credit_ledger_promo_org" RENAME TO "idx_transactions_promo_org"`;
  await sql`ALTER INDEX IF EXISTS "idx_credit_ledger_reload_pi" RENAME TO "idx_transactions_reload_pi"`;

  await sql`CREATE INDEX IF NOT EXISTS "idx_transactions_org_id" ON "transactions" USING btree ("org_id")`;
  await sql`CREATE INDEX IF NOT EXISTS "idx_transactions_status" ON "transactions" USING btree ("status")`;
  await sql`CREATE INDEX IF NOT EXISTS "idx_transactions_source" ON "transactions" USING btree ("source")`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "idx_transactions_promo_org" ON "transactions" ("promo_code_id", "org_id") WHERE source = 'promo'`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "idx_transactions_reload_pi" ON "transactions" ("org_id", "stripe_payment_intent_id") WHERE source = 'reload' AND stripe_payment_intent_id IS NOT NULL`;

  // Old column migrations (idempotent on a fresh schema).
  await sql`
    DO $$ BEGIN
      UPDATE transactions SET brand_ids = ARRAY[brand_id] WHERE brand_id IS NOT NULL AND brand_ids IS NULL;
      ALTER TABLE transactions DROP COLUMN IF EXISTS brand_id;
    EXCEPTION WHEN undefined_column THEN
      NULL;
    END $$
  `;
  await sql`
    DO $$ BEGIN
      ALTER TABLE transactions RENAME COLUMN workflow_name TO workflow_slug;
    EXCEPTION WHEN undefined_column THEN
      NULL;
    END $$
  `;

  await sql`DROP TABLE IF EXISTS "promo_redemptions"`;
});
afterAll(() => console.log("Test suite complete."));
