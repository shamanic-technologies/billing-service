/**
 * Migration 0048, replayed against the 0047 table shape.
 *
 * The funnel column goes, the table is renamed, the key becomes the campaign,
 * and NO money moves: every row keeps its amount, timestamp, channel, offer and
 * leg. Two funnels funding one campaign would collapse onto one key, so the
 * migration REFUSES that state instead of merging it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "../../src/db/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const MIGRATION = readFileSync(
  new URL("../../drizzle/0048_drop_funnel_from_ceilings.sql", import.meta.url),
  "utf8"
);
const STATEMENTS = MIGRATION.split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

const ORG = "00000000-0000-0000-0000-0000000048f1";
const BRAND = "00000000-0000-0000-0000-000000048f01";
const OFFER = "aaaaaaaa-1148-4148-8148-aaaaaaaaaaaa";
const COLD = "sales-cold-email-outreach";
const LEG = "start_to_conversation";

/** The table exactly as 0047 left it in production. */
async function toPre0048Shape(): Promise<void> {
  await sql.unsafe(`DROP TABLE IF EXISTS "campaign_daily_budgets"`);
  await sql.unsafe(`DROP TABLE IF EXISTS "brand_funnel_daily_budgets"`);
  await sql.unsafe(`
    CREATE TABLE "brand_funnel_daily_budgets" (
      "org_id" uuid NOT NULL,
      "brand_id" uuid NOT NULL,
      "funnel_key" text,
      "daily_budget_cents" numeric(16,10) NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      "feature_slug" text NOT NULL,
      "offer_id" uuid,
      "leg_key" text,
      CONSTRAINT "brand_funnel_daily_budgets_leg_key"
        UNIQUE NULLS NOT DISTINCT ("org_id", "brand_id", "funnel_key", "feature_slug", "offer_id", "leg_key")
    )
  `);
  await sql.unsafe(`CREATE INDEX "brand_funnel_daily_budgets_org_brand_idx" ON "brand_funnel_daily_budgets" ("org_id", "brand_id")`);
  await sql.unsafe(`CREATE INDEX "brand_funnel_daily_budgets_org_brand_funnel_idx" ON "brand_funnel_daily_budgets" ("org_id", "brand_id", "funnel_key")`);
  await sql.unsafe(`CREATE INDEX "brand_funnel_daily_budgets_org_brand_funnel_channel_idx" ON "brand_funnel_daily_budgets" ("org_id", "brand_id", "funnel_key", "feature_slug")`);
  await sql.unsafe(`CREATE INDEX "brand_funnel_daily_budgets_org_brand_funnel_channel_offer_idx" ON "brand_funnel_daily_budgets" ("org_id", "brand_id", "funnel_key", "feature_slug", "offer_id")`);
}

async function runMigration(): Promise<void> {
  await sql.begin(async (tx) => {
    for (const statement of STATEMENTS) await tx.unsafe(statement);
  });
}

describe("migration 0048 — the funnel leaves the ceilings, and nothing moves", () => {
  beforeAll(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    // Leave the table in the shape tests/setup.ts builds, for every later file.
    await toPre0048Shape();
    await runMigration();
    await cleanTestData();
    await closeDb();
  });

  it("keeps every row byte-identical, is idempotent, and keys on the campaign", async () => {
    await toPre0048Shape();
    await sql.unsafe(`
      INSERT INTO brand_funnel_daily_budgets (org_id, brand_id, funnel_key, feature_slug, offer_id, leg_key, daily_budget_cents, updated_at)
      VALUES
        ('${ORG}', '${BRAND}', 'reply_meeting', '${COLD}', '${OFFER}', '${LEG}', 1000.0000000000, '2026-09-01T10:00:00.764549Z'),
        ('${ORG}', '${BRAND}', 'visit_form', '${COLD}', NULL, NULL, 800.0000000000, '2026-09-02T10:00:00Z'),
        ('${ORG}', '${BRAND}', NULL, 'google-ads', '${OFFER}', '${LEG}', 500.0000000000, '2026-09-03T10:00:00Z')
    `);
    const cols = `org_id, brand_id, feature_slug, offer_id, leg_key, daily_budget_cents, updated_at::text AS updated_at`;
    const before = await sql.unsafe(
      `SELECT ${cols} FROM brand_funnel_daily_budgets ORDER BY feature_slug, offer_id NULLS FIRST`
    );

    await runMigration();
    await runMigration();

    const after = await sql.unsafe(
      `SELECT ${cols} FROM campaign_daily_budgets ORDER BY feature_slug, offer_id NULLS FIRST`
    );
    expect(after).toEqual(before);

    const old = await sql.unsafe(`SELECT to_regclass('brand_funnel_daily_budgets') AS t`);
    expect(old[0].t).toBeNull();

    const funnelCol = await sql.unsafe(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'campaign_daily_budgets' AND column_name = 'funnel_key'`
    );
    expect(funnelCol).toHaveLength(0);

    const indexes = await sql.unsafe(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'campaign_daily_budgets' ORDER BY indexname`
    );
    expect(indexes.map((i) => i.indexname)).toEqual([
      "campaign_daily_budgets_campaign_key",
      "campaign_daily_budgets_org_brand_idx",
    ]);

    // One campaign, one row — including an unscoped (NULL offer / leg) one.
    await expect(
      sql.unsafe(`
        INSERT INTO campaign_daily_budgets (org_id, brand_id, feature_slug, offer_id, leg_key, daily_budget_cents)
        VALUES ('${ORG}', '${BRAND}', '${COLD}', NULL, NULL, 1)`)
    ).rejects.toThrow(/unique/i);
  });

  it("refuses two funnels funding one campaign, and applies nothing", async () => {
    await toPre0048Shape();
    await sql.unsafe(`
      INSERT INTO brand_funnel_daily_budgets (org_id, brand_id, funnel_key, feature_slug, offer_id, leg_key, daily_budget_cents)
      VALUES
        ('${ORG}', '${BRAND}', 'reply_meeting', '${COLD}', '${OFFER}', '${LEG}', 1000),
        ('${ORG}', '${BRAND}', 'visit_meeting', '${COLD}', '${OFFER}', '${LEG}', 600)
    `);

    await expect(runMigration()).rejects.toThrow(/consolidate them/);

    const still = await sql.unsafe(`SELECT count(*)::int AS n FROM brand_funnel_daily_budgets`);
    expect(still[0].n).toBe(2);
  });
});
