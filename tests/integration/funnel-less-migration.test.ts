/**
 * Migration 0047, replayed against the 0039 table shape (funnel_key NOT NULL).
 *
 * NOTHING moves: no row, amount, timestamp, funnel, channel, offer or leg. The
 * only change is that funnel_key accepts NULL — a ceiling stated per campaign —
 * and the NULLS NOT DISTINCT key keeps two funnel-less ceilings of one campaign
 * unrepresentable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "../../src/db/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const MIGRATION = readFileSync(
  new URL("../../drizzle/0047_funnel_less_ceilings.sql", import.meta.url),
  "utf8"
);

const ORG = "00000000-0000-0000-0000-0000000047f1";
const BRAND = "00000000-0000-0000-0000-000000047f01";
const OFFER = "aaaaaaaa-1147-4147-8147-aaaaaaaaaaaa";
const COLD = "sales-cold-email-outreach";
const LEG = "start_to_conversation";

async function toShape(funnelKeyType: string): Promise<void> {
  await sql.unsafe(`DROP TABLE IF EXISTS "brand_funnel_daily_budgets"`);
  await sql.unsafe(`
    CREATE TABLE "brand_funnel_daily_budgets" (
      "org_id" uuid NOT NULL,
      "brand_id" uuid NOT NULL,
      "funnel_key" ${funnelKeyType},
      "feature_slug" text NOT NULL,
      "offer_id" uuid,
      "leg_key" text,
      "daily_budget_cents" numeric(16,10) NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "brand_funnel_daily_budgets_leg_key"
        UNIQUE NULLS NOT DISTINCT ("org_id", "brand_id", "funnel_key", "feature_slug", "offer_id", "leg_key")
    )
  `);
}

describe("migration 0047 — a ceiling may carry no funnel, and nothing moves", () => {
  beforeAll(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await toShape("text");
    await cleanTestData();
    await closeDb();
  });

  it("keeps every row byte-identical, is idempotent, and keys funnel-less rows NULLS NOT DISTINCT", async () => {
    await toShape("text NOT NULL");
    await sql.unsafe(`
      INSERT INTO brand_funnel_daily_budgets (org_id, brand_id, funnel_key, feature_slug, offer_id, leg_key, daily_budget_cents, updated_at)
      VALUES
        ('${ORG}', '${BRAND}', 'reply_meeting', '${COLD}', '${OFFER}', '${LEG}', 1000.0000000000, '2026-09-01T10:00:00.764549Z'),
        ('${ORG}', '${BRAND}', 'visit_form', '${COLD}', NULL, NULL, 800.0000000000, '2026-09-02T10:00:00Z')
    `);
    const snapshot = `SELECT * FROM brand_funnel_daily_budgets ORDER BY funnel_key`;
    const before = await sql.unsafe(snapshot);

    await sql.unsafe(MIGRATION);
    await sql.unsafe(MIGRATION);

    expect(await sql.unsafe(snapshot)).toEqual(before);

    const col = await sql.unsafe(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'brand_funnel_daily_budgets' AND column_name = 'funnel_key'`
    );
    expect(col[0].is_nullable).toBe("YES");

    const insertFunnelLess = `
      INSERT INTO brand_funnel_daily_budgets (org_id, brand_id, funnel_key, feature_slug, offer_id, leg_key, daily_budget_cents)
      VALUES ('${ORG}', '${BRAND}', NULL, '${COLD}', '${OFFER}', '${LEG}', 500.0000000000)`;
    await sql.unsafe(insertFunnelLess);
    await expect(sql.unsafe(insertFunnelLess)).rejects.toThrow(/unique/i);
  });
});
