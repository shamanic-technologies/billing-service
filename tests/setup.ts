import { beforeAll, afterAll } from "vitest";

process.env.BILLING_SERVICE_DATABASE_URL =
  process.env.BILLING_SERVICE_DATABASE_URL ||
  "postgresql://test:test@localhost/test";
process.env.BILLING_SERVICE_API_KEY = "test-api-key";
process.env.KEY_SERVICE_URL = "http://localhost:9999";
process.env.KEY_SERVICE_API_KEY = "test-key-service-key";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fake";
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
      "brand_id" text,
      "workflow_name" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS "idx_credit_provisions_org_id" ON "credit_provisions" USING btree ("org_id")`;
  await sql`CREATE INDEX IF NOT EXISTS "idx_credit_provisions_status" ON "credit_provisions" USING btree ("status")`;
});
afterAll(() => console.log("Test suite complete."));
