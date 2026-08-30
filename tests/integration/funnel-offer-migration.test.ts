/**
 * Migration 0037, replayed against the 0036 table shape.
 *
 * The whole point is that NOTHING moves: no amount, no timestamp, no funnel and
 * no channel. There is no backfill, because only brand-service knows which offer
 * a live ceiling belongs to and guessing would attach real money to the wrong
 * campaign — so every pre-0037 ceiling keeps `offer_id IS NULL`, which is a
 * permanent value meaning "not scoped to an offer".
 *
 * What DOES change is the key: two offers of one (funnel, channel) pair must be
 * representable, while two UNSCOPED ceilings of that pair must not be.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "../../src/db/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const MIGRATION = readFileSync(
  new URL("../../drizzle/0037_brand_funnel_offer_budgets.sql", import.meta.url),
  "utf8"
);

const ORG = "00000000-0000-0000-0000-00000000ad01";
const BRAND = "00000000-0000-0000-0000-0000000adb01";
const OFFER = "aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa";

const COLD = "sales-cold-email-outreach";
const CRM = "sales-crm-email-outreach";

async function toPre0037Shape(): Promise<void> {
  await sql.unsafe(`DROP TABLE IF EXISTS "brand_funnel_daily_budgets"`);
  await sql.unsafe(`
    CREATE TABLE "brand_funnel_daily_budgets" (
      "org_id" uuid NOT NULL,
      "brand_id" uuid NOT NULL,
      "funnel_key" text NOT NULL,
      "feature_slug" text NOT NULL,
      "daily_budget_cents" numeric(16,10) NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "brand_funnel_daily_budgets_pkey"
        PRIMARY KEY ("org_id", "brand_id", "funnel_key", "feature_slug")
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
      "offer_id" uuid,
      "leg_key" text,
      "daily_budget_cents" numeric(16,10) NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "brand_funnel_daily_budgets_leg_key"
        UNIQUE NULLS NOT DISTINCT ("org_id", "brand_id", "funnel_key", "feature_slug", "offer_id", "leg_key")
    )
  `);
}

describe("migration 0037 — the ceiling gains the offer, and nothing moves", () => {
  beforeAll(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await toCurrentShape();
    await cleanTestData();
    await closeDb();
  });

  it("keeps every ceiling unscoped and untouched, and re-applying is a no-op", async () => {
    await toPre0037Shape();
    await sql.unsafe(`
      INSERT INTO brand_funnel_daily_budgets (org_id, brand_id, funnel_key, feature_slug, daily_budget_cents, updated_at)
      VALUES
        ('${ORG}', '${BRAND}', 'visit_signup', '${CRM}', 100.0000000000, '2026-08-01T10:00:00Z'),
        ('${ORG}', '${BRAND}', 'reply_meeting', '${COLD}', 5000.0000000000, '2026-08-02T11:22:33.764549Z')
    `);

    const before = await sql.unsafe(
      `SELECT org_id, brand_id, funnel_key, feature_slug, daily_budget_cents, updated_at
         FROM brand_funnel_daily_budgets ORDER BY funnel_key`
    );

    await sql.unsafe(MIGRATION);

    const after = await sql.unsafe(
      `SELECT org_id, brand_id, funnel_key, feature_slug, offer_id, daily_budget_cents, updated_at
         FROM brand_funnel_daily_budgets ORDER BY funnel_key`
    );

    // Same rows, same money, same timestamps, same channel — only the (null)
    // offer is new. A truncated microsecond would show up here.
    expect(after.length).toBe(before.length);
    for (const [i, row] of after.entries()) {
      expect(row.daily_budget_cents).toBe(before[i].daily_budget_cents);
      expect(row.updated_at).toEqual(before[i].updated_at);
      expect(row.funnel_key).toBe(before[i].funnel_key);
      expect(row.feature_slug).toBe(before[i].feature_slug);
      expect(row.offer_id).toBeNull();
    }

    // Re-applying moves nothing.
    await sql.unsafe(MIGRATION);
    const replayed = await sql.unsafe(
      `SELECT org_id, brand_id, funnel_key, feature_slug, offer_id, daily_budget_cents, updated_at
         FROM brand_funnel_daily_budgets ORDER BY funnel_key`
    );
    expect(replayed).toEqual(after);

    // The key now carries the offer, over five columns, and NULLs are treated as
    // equal so a pair still cannot hold two unscoped ceilings.
    const key = await sql.unsafe(`
      SELECT array_length(c.conkey, 1) AS cols, i.indnullsnotdistinct AS nnd
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_index i ON i.indexrelid = c.conindid
       WHERE t.relname = 'brand_funnel_daily_budgets' AND c.contype = 'u'
    `);
    expect(Number(key[0].cols)).toBe(5);
    expect(key[0].nnd).toBe(true);

    await expect(
      sql.unsafe(`
        INSERT INTO brand_funnel_daily_budgets (org_id, brand_id, funnel_key, feature_slug, daily_budget_cents)
        VALUES ('${ORG}', '${BRAND}', 'reply_meeting', '${COLD}', 1.0)
      `)
    ).rejects.toThrow();

    // But a second OFFER on that same pair is now representable — the whole
    // reason the key changed.
    await sql.unsafe(`
      INSERT INTO brand_funnel_daily_budgets (org_id, brand_id, funnel_key, feature_slug, offer_id, daily_budget_cents)
      VALUES ('${ORG}', '${BRAND}', 'reply_meeting', '${COLD}', '${OFFER}', 2500.0000000000)
    `);
    const split = await sql.unsafe(
      `SELECT count(*)::int AS n FROM brand_funnel_daily_budgets
        WHERE funnel_key = 'reply_meeting' AND feature_slug = '${COLD}'`
    );
    expect(split[0].n).toBe(2);
  });
});
