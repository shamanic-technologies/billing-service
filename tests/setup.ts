import { beforeAll, afterAll } from "vitest";

process.env.BILLING_SERVICE_DATABASE_URL =
  process.env.BILLING_SERVICE_DATABASE_URL ||
  "postgresql://test:test@localhost/test";
process.env.BILLING_SERVICE_API_KEY = "test-api-key";
process.env.KEY_SERVICE_URL = "http://localhost:9999";
process.env.KEY_SERVICE_API_KEY = "test-key-service-key";
process.env.STRIPE_SERVICE_URL = "http://localhost:9996";
process.env.STRIPE_SERVICE_API_KEY = "test-stripe-service-key";
process.env.COSTS_SERVICE_URL = "http://localhost:9998";
process.env.COSTS_SERVICE_API_KEY = "test-costs-service-key";
process.env.RUNS_SERVICE_URL = "http://localhost:9997";
process.env.RUNS_SERVICE_API_KEY = "test-runs-service-key";
process.env.NODE_ENV = "test";

beforeAll(async () => {
  console.log("Test suite starting...");

  const { sql } = await import("../src/db/index.js");

  // Fresh-DB path — create billing_accounts (post-#0016 shape: topup config only).
  await sql`
    CREATE TABLE IF NOT EXISTS "billing_accounts" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "org_id" uuid NOT NULL,
      "topup_amount_cents" integer,
      "topup_threshold_cents" integer DEFAULT 200,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "idx_billing_accounts_org_id" ON "billing_accounts" ("org_id")`;

  // Drop legacy columns if a stale local DB still has them.
  await sql`ALTER TABLE "billing_accounts" DROP COLUMN IF EXISTS "balance_cents"`;
  await sql`ALTER TABLE "billing_accounts" DROP COLUMN IF EXISTS "stripe_customer_id"`;
  await sql`ALTER TABLE "billing_accounts" DROP COLUMN IF EXISTS "stripe_payment_method_id"`;
  await sql`ALTER TABLE "billing_accounts" DROP COLUMN IF EXISTS "billing_mode"`;
  await sql`DROP INDEX IF EXISTS "idx_billing_accounts_stripe_customer"`;

  // local_promo_codes (code definitions).
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

  // local_promos (per-org credit grants — welcome gift + promo redemptions +
  // admin grants unified).
  await sql`
    CREATE TABLE IF NOT EXISTS "local_promos" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "org_id" uuid NOT NULL,
      "user_id" uuid NOT NULL,
      "amount_cents" numeric(16,10) NOT NULL,
      "promo_code_id" uuid NOT NULL REFERENCES "local_promo_codes"("id"),
      "description" text,
      "brand_ids" text[],
      "granted_by" text,
      "idempotency_key" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;
  // Stale-DB path: add migration-0025 columns if an older local DB predates them.
  await sql`ALTER TABLE "local_promos" ADD COLUMN IF NOT EXISTS "granted_by" text`;
  await sql`ALTER TABLE "local_promos" ADD COLUMN IF NOT EXISTS "idempotency_key" text`;
  // (org, promo_code) uniqueness is PARTIAL post-0025 (admin_grant rows carry an
  // idempotency_key and stack). DROP first so a stale full index is replaced.
  await sql`DROP INDEX IF EXISTS "idx_local_promos_org_promo"`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "idx_local_promos_org_promo" ON "local_promos" ("org_id", "promo_code_id") WHERE "idempotency_key" IS NULL`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "idx_local_promos_org_idempotency" ON "local_promos" ("org_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS "idx_local_promos_org" ON "local_promos" ("org_id")`;

  // credit_depletion_episodes (out-of-credit dunning engine, migration 0019).
  await sql`
    CREATE TABLE IF NOT EXISTS "credit_depletion_episodes" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "org_id" uuid NOT NULL,
      "user_id" uuid NOT NULL,
      "run_id" uuid,
      "campaign_id" uuid,
      "started_at" timestamp with time zone DEFAULT now() NOT NULL,
      "credited_cents_at_open" numeric(16,10),
      "t0_sent_at" timestamp with time zone,
      "followup_3d_sent_at" timestamp with time zone,
      "followup_10d_sent_at" timestamp with time zone,
      "recovered_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;
  // Stale-DB path: add the migration-0020 column if an older local DB predates it.
  await sql`ALTER TABLE "credit_depletion_episodes" ADD COLUMN IF NOT EXISTS "credited_cents_at_open" numeric(16,10)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "idx_one_open_episode_per_org" ON "credit_depletion_episodes" ("org_id") WHERE "recovered_at" IS NULL`;
  await sql`CREATE INDEX IF NOT EXISTS "idx_credit_depletion_open" ON "credit_depletion_episodes" ("recovered_at")`;

  // Seed welcome promo code (matches migration 0028 @500, the canonical amount
  // after 0016 @200 → 0018 @2500 → 0019 @200 → 0028 @500).
  // DO UPDATE (not DO NOTHING) so a stale local DB seeded at an old amount gets
  // set to 500 on re-run — keeps welcome-amount assertions deterministic.
  await sql`
    INSERT INTO "local_promo_codes" ("code", "amount_cents", "max_redemptions", "expires_at")
    VALUES ('welcome', 500, NULL, NULL)
    ON CONFLICT ("code") DO UPDATE SET "amount_cents" = EXCLUDED."amount_cents"
  `;

  // campaign_authorize_costs (per-campaign affordability estimate, migration 0021).
  await sql`
    CREATE TABLE IF NOT EXISTS "campaign_authorize_costs" (
      "campaign_id" uuid PRIMARY KEY NOT NULL,
      "org_id" uuid NOT NULL,
      "last_authorize_required_cents" numeric(16,10) NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;

  // brand_daily_budgets (org-scoped per-brand daily spend ceiling, migrations 0022 + 0024).
  await sql`
    CREATE TABLE IF NOT EXISTS "brand_daily_budgets" (
      "brand_id" uuid NOT NULL,
      "org_id" uuid NOT NULL,
      "daily_budget_cents" numeric(16,10) NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      PRIMARY KEY ("org_id", "brand_id")
    )
  `;
  await sql`
    ALTER TABLE "brand_daily_budgets"
      DROP CONSTRAINT IF EXISTS "brand_daily_budgets_pkey"
  `;
  await sql`
    ALTER TABLE "brand_daily_budgets"
      ADD CONSTRAINT "brand_daily_budgets_pkey"
      PRIMARY KEY ("org_id", "brand_id")
  `;

  // brand_daily_budget_changes (append-only daily-budget history, migration 0027).
  await sql`
    CREATE TABLE IF NOT EXISTS "brand_daily_budget_changes" (
      "id" bigserial PRIMARY KEY,
      "org_id" uuid NOT NULL,
      "brand_id" uuid NOT NULL,
      "daily_budget_cents" numeric(16,10) NOT NULL,
      "changed_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS "brand_daily_budget_changes_org_brand_changed_at_idx"
      ON "brand_daily_budget_changes" ("org_id", "brand_id", "changed_at", "id")
  `;

  // org_usage_discounts (per-org platform-usage discount, migration 0026).
  await sql`
    CREATE TABLE IF NOT EXISTS "org_usage_discounts" (
      "org_id" uuid PRIMARY KEY,
      "discount_pct" integer NOT NULL,
      "set_by" text,
      "set_at" timestamp with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "org_usage_discount_pct_range" CHECK ("discount_pct" >= 0 AND "discount_pct" <= 100)
    )
  `;

  // Seed platform-issued grant promo codes (matches migrations 0017 + 0025).
  await sql`
    INSERT INTO "local_promo_codes" ("code", "amount_cents", "max_redemptions", "expires_at")
    VALUES ('invite_reward', 2500, NULL, NULL),
           ('invite_welcome', 2500, NULL, NULL),
           ('first_load_match', 0, NULL, NULL),
           ('admin_grant', 0, NULL, NULL)
    ON CONFLICT ("code") DO UPDATE SET "amount_cents" = EXCLUDED."amount_cents"
  `;

  // Drop legacy tables that may linger.
  await sql`DROP TABLE IF EXISTS "customer_balance_transactions"`;
  await sql`DROP TABLE IF EXISTS "cbt_archive_pre104_usage"`;
  await sql`DROP TABLE IF EXISTS "transactions_archive_pre104_charges"`;
  await sql`DROP TABLE IF EXISTS "transactions"`;
  await sql`DROP TABLE IF EXISTS "credit_ledger"`;
  await sql`DROP TABLE IF EXISTS "credit_provisions"`;
  await sql`DROP TABLE IF EXISTS "promo_redemptions"`;
});

afterAll(() => console.log("Test suite complete."));
