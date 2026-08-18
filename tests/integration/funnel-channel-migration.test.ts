/**
 * Migration 0036, replayed against the pre-0036 table shape with the ceilings
 * production actually held.
 *
 * What matters is not that the column appears — it is that every ceiling keeps
 * its exact value and lands on the channel that brand really runs. Two sales
 * features exist in production, so the migration names the verified CRM ceiling
 * explicitly and lets everything else take the default; this pins both halves.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "../../src/db/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const MIGRATION = readFileSync(
  new URL("../../drizzle/0036_brand_funnel_channel_budgets.sql", import.meta.url),
  "utf8"
);

/** The prod CRM exception the migration names (org / brand / funnel). */
const CRM_ORG = "b645207b-d8e9-40b0-9391-072b777cd9a9";
const CRM_BRAND = "ccc29ba2-78ce-48fc-a57c-16c4fa0e1449";

const COLD_ORG = "00000000-0000-0000-0000-00000000ab01";
const COLD_BRAND = "00000000-0000-0000-0000-0000000abb01";

async function toPre0036Shape(): Promise<void> {
  await sql.unsafe(`DROP TABLE IF EXISTS "brand_funnel_daily_budgets"`);
  await sql.unsafe(`
    CREATE TABLE "brand_funnel_daily_budgets" (
      "org_id" uuid NOT NULL,
      "brand_id" uuid NOT NULL,
      "funnel_key" text NOT NULL,
      "daily_budget_cents" numeric(16,10) NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      PRIMARY KEY ("org_id", "brand_id", "funnel_key")
    )
  `);
}

async function toCurrentShape(): Promise<void> {
  await sql.unsafe(`DROP TABLE IF EXISTS "brand_funnel_daily_budgets"`);
  await sql.unsafe(`
    CREATE TABLE "brand_funnel_daily_budgets" (
      "org_id" uuid NOT NULL,
      "brand_id" uuid NOT NULL,
      "funnel_key" text NOT NULL,
      "feature_slug" text NOT NULL,
      "daily_budget_cents" numeric(16,10) NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      PRIMARY KEY ("org_id", "brand_id", "funnel_key", "feature_slug")
    )
  `);
}

describe("migration 0036 — the ceiling gains the channel it already runs", () => {
  beforeAll(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await toCurrentShape();
    await cleanTestData();
    await closeDb();
  });

  it("keeps every ceiling and names the right channel, and re-applying is a no-op", async () => {
    await toPre0036Shape();
    await sql.unsafe(`
      INSERT INTO brand_funnel_daily_budgets (org_id, brand_id, funnel_key, daily_budget_cents, updated_at)
      VALUES
        ('${CRM_ORG}', '${CRM_BRAND}', 'visit_signup', 100.0000000000, '2026-08-01T10:00:00Z'),
        ('${CRM_ORG}', '75d7e3e8-6926-4f85-a557-976895400666', 'reply_meeting', 5000.0000000000, '2026-08-01T10:00:00Z'),
        ('${COLD_ORG}', '${COLD_BRAND}', 'visit_form', 800.0000000000, '2026-08-02T11:22:33.764549Z')
    `);

    const before = await sql.unsafe(
      `SELECT org_id, brand_id, funnel_key, daily_budget_cents, updated_at
         FROM brand_funnel_daily_budgets ORDER BY org_id, brand_id, funnel_key`
    );

    await sql.unsafe(MIGRATION);

    const after = await sql.unsafe(
      `SELECT org_id, brand_id, funnel_key, feature_slug, daily_budget_cents, updated_at
         FROM brand_funnel_daily_budgets ORDER BY org_id, brand_id, funnel_key`
    );

    // Same rows, same money, same timestamps — only the channel is new.
    expect(after.length).toBe(before.length);
    for (const [i, row] of after.entries()) {
      expect(row.daily_budget_cents).toBe(before[i].daily_budget_cents);
      expect(row.updated_at).toEqual(before[i].updated_at);
      expect(row.funnel_key).toBe(before[i].funnel_key);
    }

    const slugOf = (orgId: string, brandId: string, funnelKey: string) =>
      after.find(
        (r) =>
          r.org_id === orgId &&
          r.brand_id === brandId &&
          r.funnel_key === funnelKey
      )?.feature_slug;

    expect(slugOf(CRM_ORG, CRM_BRAND, "visit_signup")).toBe(
      "sales-crm-email-outreach"
    );
    expect(
      slugOf(CRM_ORG, "75d7e3e8-6926-4f85-a557-976895400666", "reply_meeting")
    ).toBe("sales-cold-email-outreach");
    expect(slugOf(COLD_ORG, COLD_BRAND, "visit_form")).toBe(
      "sales-cold-email-outreach"
    );

    // The key now carries the channel, so one funnel can hold several.
    const key = await sql.unsafe(`
      SELECT array_length(c.conkey, 1) AS cols
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'brand_funnel_daily_budgets' AND c.contype = 'p'
    `);
    expect(Number(key[0].cols)).toBe(4);

    // Re-applying moves nothing: the CRM row is not re-stamped to the default.
    await sql.unsafe(MIGRATION);
    const replayed = await sql.unsafe(
      `SELECT org_id, brand_id, funnel_key, feature_slug, daily_budget_cents, updated_at
         FROM brand_funnel_daily_budgets ORDER BY org_id, brand_id, funnel_key`
    );
    expect(replayed).toEqual(after);
  });
});
