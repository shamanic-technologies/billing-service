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

  // -- billing_accounts --
  // Drop legacy `billing_mode` column if a stale schema is around.
  await sql`
    DO $$ BEGIN
      ALTER TABLE billing_accounts DROP COLUMN IF EXISTS billing_mode;
    EXCEPTION WHEN undefined_column THEN NULL;
    END $$
  `;

  // Walk legacy column-name history so a stale local DB lands on v3.
  await sql`
    DO $$ BEGIN
      ALTER TABLE billing_accounts RENAME COLUMN credit_balance_cents TO balance_cents;
    EXCEPTION WHEN undefined_column THEN NULL;
              WHEN duplicate_column THEN NULL;
    END $$
  `;
  await sql`
    DO $$ BEGIN
      ALTER TABLE billing_accounts RENAME COLUMN reload_amount_cents TO topup_amount_cents;
    EXCEPTION WHEN undefined_column THEN NULL;
              WHEN duplicate_column THEN NULL;
    END $$
  `;
  await sql`
    DO $$ BEGIN
      ALTER TABLE billing_accounts RENAME COLUMN reload_threshold_cents TO topup_threshold_cents;
    EXCEPTION WHEN undefined_column THEN NULL;
              WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Fresh-DB path — create v3 billing_accounts directly.
  await sql`
    CREATE TABLE IF NOT EXISTS "billing_accounts" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "org_id" uuid NOT NULL,
      "stripe_customer_id" text,
      "balance_cents" numeric(16,10) DEFAULT 200 NOT NULL,
      "topup_amount_cents" integer,
      "topup_threshold_cents" integer DEFAULT 200,
      "stripe_payment_method_id" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "idx_billing_accounts_org_id" ON "billing_accounts" ("org_id")`;
  await sql`CREATE INDEX IF NOT EXISTS "idx_billing_accounts_stripe_customer" ON "billing_accounts" ("stripe_customer_id")`;

  // Promote integer balance_cents to numeric (legacy local DBs may still be int).
  await sql`
    DO $$ BEGIN
      IF (SELECT data_type FROM information_schema.columns
          WHERE table_name = 'billing_accounts' AND column_name = 'balance_cents') = 'integer'
      THEN
        ALTER TABLE "billing_accounts" ALTER COLUMN "balance_cents" TYPE numeric(16,10) USING "balance_cents"::numeric(16,10);
        ALTER TABLE "billing_accounts" ALTER COLUMN "balance_cents" SET DEFAULT 200;
      END IF;
    END $$
  `;

  // -- local_promo_codes --
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
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "idx_local_promo_codes_code" ON "local_promo_codes" ("code")`;

  // -- customer_balance_transactions --
  // Walk legacy table-name history (credit_provisions → credit_ledger → transactions → customer_balance_transactions).
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

  // If only the legacy `transactions` table exists, apply the v3 transforms then rename.
  await sql`
    DO $$
    DECLARE has_transactions boolean;
            has_v3 boolean;
            has_legacy_type boolean;
            has_legacy_source boolean;
            has_legacy_balance_txn boolean;
    BEGIN
      SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'transactions') INTO has_transactions;
      SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_balance_transactions') INTO has_v3;
      IF has_transactions AND NOT has_v3 THEN
        SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='transactions' AND column_name='type') INTO has_legacy_type;
        SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='transactions' AND column_name='source') INTO has_legacy_source;
        SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='transactions' AND column_name='stripe_balance_txn_id') INTO has_legacy_balance_txn;

        -- Promote amount_cents to numeric if needed.
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_name = 'transactions' AND column_name = 'amount_cents') = 'integer'
        THEN
          ALTER TABLE "transactions" ALTER COLUMN "amount_cents" TYPE numeric(16,10) USING "amount_cents"::numeric(16,10);
        END IF;

        IF has_legacy_type AND has_legacy_source THEN
          -- v2-shape legacy: type ∈ {credit,debit}, source ∈ {reload,welcome,promo,refund,charge,...}
          UPDATE "transactions" SET "amount_cents" = -"amount_cents" WHERE "type" = 'credit';
          UPDATE "transactions" SET "status" = 'requires_capture' WHERE "status" = 'pending';
          UPDATE "transactions" SET "status" = 'succeeded' WHERE "status" = 'confirmed';
          UPDATE "transactions" SET "status" = 'canceled' WHERE "status" = 'cancelled';
          ALTER TABLE "transactions" DROP COLUMN "type";
          ALTER TABLE "transactions" RENAME COLUMN "source" TO "type";
          UPDATE "transactions" SET "type" = 'payment' WHERE "type" = 'reload';
          UPDATE "transactions" SET "type" = 'gift' WHERE "type" = 'welcome';
          UPDATE "transactions" SET "type" = 'usage_applied' WHERE "type" = 'charge';
        END IF;

        IF has_legacy_balance_txn THEN
          ALTER TABLE "transactions" RENAME COLUMN "stripe_balance_txn_id" TO "stripe_balance_transaction_id";
        END IF;

        -- Index renames (best effort).
        BEGIN ALTER INDEX "idx_transactions_org_id" RENAME TO "idx_cbt_org_id"; EXCEPTION WHEN undefined_object THEN NULL; END;
        BEGIN ALTER INDEX "idx_transactions_status" RENAME TO "idx_cbt_status"; EXCEPTION WHEN undefined_object THEN NULL; END;
        BEGIN ALTER INDEX "idx_transactions_source" RENAME TO "idx_cbt_type"; EXCEPTION WHEN undefined_object THEN NULL; END;
        BEGIN ALTER INDEX "idx_transactions_cost_id" RENAME TO "idx_cbt_cost_id"; EXCEPTION WHEN undefined_object THEN NULL; END;
        BEGIN ALTER INDEX "idx_transactions_brand_ids" RENAME TO "idx_cbt_brand_ids"; EXCEPTION WHEN undefined_object THEN NULL; END;
        BEGIN ALTER INDEX "idx_transactions_promo_org" RENAME TO "idx_cbt_promo_org"; EXCEPTION WHEN undefined_object THEN NULL; END;
        BEGIN DROP INDEX "idx_transactions_reload_pi"; EXCEPTION WHEN undefined_object THEN NULL; END;
        BEGIN DROP INDEX "idx_cbt_payment_pi"; EXCEPTION WHEN undefined_object THEN NULL; END;

        ALTER TABLE "transactions" RENAME TO "customer_balance_transactions";
      END IF;
    END $$
  `;

  // Fresh-DB path — create v3 customer_balance_transactions directly.
  await sql`
    CREATE TABLE IF NOT EXISTS "customer_balance_transactions" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "org_id" uuid NOT NULL,
      "user_id" uuid NOT NULL,
      "run_id" uuid,
      "cost_id" uuid,
      "type" text DEFAULT 'payment' NOT NULL,
      "amount_cents" numeric(16,10) NOT NULL,
      "status" text DEFAULT 'requires_capture' NOT NULL,
      "stripe_payment_intent_id" text,
      "stripe_balance_transaction_id" text,
      "promo_code_id" uuid REFERENCES "local_promo_codes"("id"),
      "description" text,
      "campaign_id" text,
      "brand_ids" text[],
      "workflow_slug" text,
      "feature_slug" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS "idx_cbt_org_id" ON "customer_balance_transactions" ("org_id")`;
  await sql`CREATE INDEX IF NOT EXISTS "idx_cbt_status" ON "customer_balance_transactions" ("status")`;
  await sql`CREATE INDEX IF NOT EXISTS "idx_cbt_type" ON "customer_balance_transactions" ("type")`;
  await sql`CREATE INDEX IF NOT EXISTS "idx_cbt_cost_id" ON "customer_balance_transactions" ("cost_id")`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "idx_cbt_promo_org" ON "customer_balance_transactions" ("promo_code_id", "org_id") WHERE type = 'promo'`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "idx_cbt_payment_pi" ON "customer_balance_transactions" ("org_id", "stripe_payment_intent_id") WHERE type = 'payment' AND stripe_payment_intent_id IS NOT NULL`;

  // Drop legacy auxiliary tables that may linger from earlier schemas.
  await sql`DROP TABLE IF EXISTS "promo_redemptions"`;
});

afterAll(() => console.log("Test suite complete."));
