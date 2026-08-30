/**
 * Migration 0039, replayed against the 0037 table shape.
 *
 * The whole point is that NOTHING moves: no amount, no timestamp, no funnel, no
 * channel and no offer. There is no backfill, because a funnel has several legs
 * and a leg belongs to several funnels, so nothing here can derive the one a
 * live ceiling is for — every pre-0039 ceiling keeps `leg_key IS NULL`, which is
 * a permanent value meaning "not scoped to a leg".
 *
 * What DOES change is the key: two legs of one (funnel, channel, offer) triple
 * must be representable, while two LEG-LESS ceilings of that triple must not be.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "../../src/db/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const MIGRATION = readFileSync(
  new URL("../../drizzle/0039_brand_funnel_leg_budgets.sql", import.meta.url),
  "utf8"
);

const ORG = "00000000-0000-0000-0000-0000000019e1";
const BRAND = "00000000-0000-0000-0000-000000019e01";
const OFFER = "aaaaaaaa-1119-4119-8119-aaaaaaaaaaaa";

const COLD = "sales-cold-email-outreach";
const CRM = "sales-crm-email-outreach";
const LEG = "conversation_to_meeting_booked";

async function toPre0039Shape(): Promise<void> {
  await sql.unsafe(`DROP TABLE IF EXISTS "brand_funnel_daily_budgets"`);
  await sql.unsafe(`
    CREATE TABLE "brand_funnel_daily_budgets" (
      "org_id" uuid NOT NULL,
      "brand_id" uuid NOT NULL,
      "funnel_key" text NOT NULL,
      "feature_slug" text NOT NULL,
      "offer_id" uuid,
      "daily_budget_cents" numeric(16,10) NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "brand_funnel_daily_budgets_offer_key"
        UNIQUE NULLS NOT DISTINCT ("org_id", "brand_id", "funnel_key", "feature_slug", "offer_id")
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

describe("migration 0039 — the ceiling gains the leg, and nothing moves", () => {
  beforeAll(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await toCurrentShape();
    await cleanTestData();
    await closeDb();
  });

  it("keeps every ceiling leg-less and untouched, and re-applying is a no-op", async () => {
    await toPre0039Shape();
    await sql.unsafe(`
      INSERT INTO brand_funnel_daily_budgets (org_id, brand_id, funnel_key, feature_slug, offer_id, daily_budget_cents, updated_at)
      VALUES
        ('${ORG}', '${BRAND}', 'visit_signup', '${CRM}', NULL, 100.0000000000, '2026-08-01T10:00:00Z'),
        ('${ORG}', '${BRAND}', 'reply_meeting', '${COLD}', '${OFFER}', 5000.0000000000, '2026-08-02T11:22:33.764549Z')
    `);

    const before = await sql.unsafe(
      `SELECT org_id, brand_id, funnel_key, feature_slug, offer_id, daily_budget_cents, updated_at
         FROM brand_funnel_daily_budgets ORDER BY funnel_key`
    );

    await sql.unsafe(MIGRATION);

    const after = await sql.unsafe(
      `SELECT org_id, brand_id, funnel_key, feature_slug, offer_id, leg_key, daily_budget_cents, updated_at
         FROM brand_funnel_daily_budgets ORDER BY funnel_key`
    );

    // Same rows, same money, same timestamps, same channel and offer — only the
    // (null) leg is new. The microsecond in the second timestamp is deliberate:
    // a copy through a JS Date would truncate it.
    expect(after).toHaveLength(before.length);
    for (const [i, row] of after.entries()) {
      expect(row.leg_key).toBeNull();
      expect(row.daily_budget_cents).toBe(before[i].daily_budget_cents);
      expect(row.updated_at).toEqual(before[i].updated_at);
      expect(row.feature_slug).toBe(before[i].feature_slug);
      expect(row.offer_id).toBe(before[i].offer_id);
    }

    // Re-applying changes nothing.
    await sql.unsafe(MIGRATION);
    const again = await sql.unsafe(
      `SELECT count(*)::int AS n FROM brand_funnel_daily_budgets WHERE leg_key IS NOT NULL`
    );
    expect(again[0].n).toBe(0);
  });

  it("keys on six columns, treating NULLs as equal", async () => {
    const constraint = await sql.unsafe(`
      SELECT c.conname,
             (SELECT count(*)::int FROM unnest(c.conkey)) AS cols,
             i.indnullsnotdistinct
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_index i ON i.indexrelid = c.conindid
       WHERE t.relname = 'brand_funnel_daily_budgets'
         AND c.contype = 'u'
    `);
    expect(constraint).toHaveLength(1);
    expect(constraint[0].conname).toBe("brand_funnel_daily_budgets_leg_key");
    expect(constraint[0].cols).toBe(6);
    expect(constraint[0].indnullsnotdistinct).toBe(true);

    // Two legs of one triple are representable...
    await sql.unsafe(`
      INSERT INTO brand_funnel_daily_budgets (org_id, brand_id, funnel_key, feature_slug, offer_id, leg_key, daily_budget_cents)
      VALUES ('${ORG}', '${BRAND}', 'reply_meeting', '${COLD}', '${OFFER}', '${LEG}', 1200.0000000000)
    `);

    // ...while a second LEG-LESS ceiling of the same triple is not.
    await expect(
      sql.unsafe(`
        INSERT INTO brand_funnel_daily_budgets (org_id, brand_id, funnel_key, feature_slug, offer_id, leg_key, daily_budget_cents)
        VALUES ('${ORG}', '${BRAND}', 'reply_meeting', '${COLD}', '${OFFER}', NULL, 1.0000000000)
      `)
    ).rejects.toThrow();
  });
});
