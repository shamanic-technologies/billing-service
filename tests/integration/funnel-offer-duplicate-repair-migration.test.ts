/**
 * Migration 0038, replayed: the one live pair holding a campaign twice.
 *
 * Before the write-side adoption, a ceiling that named an offer was stored
 * BESIDE the pre-offer unscoped ceiling of the same (funnel, channel) pair, so
 * the per-funnel figure — a SUM — counted the customer's money twice. The
 * migration removes the superseded unscoped row and nothing else: a pair that
 * holds only an unscoped ceiling keeps it exactly as it is, because "not scoped
 * to an offer" is a permanent value and only brand-service could say which offer
 * such a ceiling belongs to.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "../../src/db/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const MIGRATION = readFileSync(
  new URL(
    "../../drizzle/0038_drop_superseded_unscoped_ceilings.sql",
    import.meta.url
  ),
  "utf8"
);

const ORG = "00000000-0000-0000-0000-00000000ae01";
const BRAND = "00000000-0000-0000-0000-0000000aeb01";
const OTHER_BRAND = "00000000-0000-0000-0000-0000000aeb02";
const OFFER = "d5ecba00-783a-4939-b5bd-f85b9e6b7d9e";

const COLD = "sales-cold-email-outreach";
const FEEDBACK = "feedback-request-cold-email-outreach";

async function rows() {
  return sql.unsafe(
    `SELECT brand_id, funnel_key, feature_slug, offer_id, daily_budget_cents, updated_at
       FROM brand_funnel_daily_budgets
      ORDER BY brand_id, funnel_key, feature_slug, offer_id NULLS FIRST`
  );
}

describe("migration 0038 — one campaign, one ceiling", () => {
  beforeAll(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("drops the superseded unscoped ceiling and leaves everything else", async () => {
    // The live shape: $40 on the sales channel stored twice (once before offers
    // existed, once under the offer its campaign belongs to), plus $10 on the
    // feedback channel that was never re-stated.
    await sql.unsafe(`
      INSERT INTO brand_funnel_daily_budgets (org_id, brand_id, funnel_key, feature_slug, offer_id, daily_budget_cents, updated_at)
      VALUES
        ('${ORG}', '${BRAND}', 'reply_meeting', '${COLD}', NULL, 4000.0000000000, '2026-08-19T13:59:39.396Z'),
        ('${ORG}', '${BRAND}', 'reply_meeting', '${COLD}', '${OFFER}', 4000.0000000000, '2026-08-20T09:08:29.757Z'),
        ('${ORG}', '${BRAND}', 'reply_meeting', '${FEEDBACK}', NULL, 1000.0000000000, '2026-08-19T13:59:41.562Z'),
        ('${ORG}', '${OTHER_BRAND}', 'visit_form', '${COLD}', NULL, 500.0000000000, '2026-08-02T03:25:49.55Z')
    `);

    const before = await rows();
    await sql.unsafe(MIGRATION);
    const after = await rows();

    expect(
      after.map((r) => [
        r.brand_id,
        r.feature_slug,
        r.offer_id,
        r.daily_budget_cents,
      ])
    ).toEqual([
      [BRAND, FEEDBACK, null, "1000.0000000000"],
      [BRAND, COLD, OFFER, "4000.0000000000"],
      [OTHER_BRAND, COLD, null, "500.0000000000"],
    ]);

    // Nothing that survives is re-stamped — same money, same timestamps.
    for (const row of after) {
      const original = before.find(
        (b) =>
          b.brand_id === row.brand_id &&
          b.feature_slug === row.feature_slug &&
          b.offer_id === row.offer_id
      );
      expect(row.daily_budget_cents).toBe(original?.daily_budget_cents);
      expect(row.updated_at).toEqual(original?.updated_at);
    }

    // The brand now sums to the $50/day that was funded, not $90/day.
    const total = await sql.unsafe(
      `SELECT sum(daily_budget_cents)::text AS total FROM brand_funnel_daily_budgets WHERE brand_id = '${BRAND}'`
    );
    expect(Number(total[0].total)).toBe(5000);

    // Re-applying deletes nothing.
    await sql.unsafe(MIGRATION);
    expect(await rows()).toEqual(after);
  });

  it("keeps an unscoped ceiling that no named offer supersedes", async () => {
    await cleanTestData();
    await sql.unsafe(`
      INSERT INTO brand_funnel_daily_budgets (org_id, brand_id, funnel_key, feature_slug, offer_id, daily_budget_cents, updated_at)
      VALUES
        ('${ORG}', '${BRAND}', 'visit_form', '${COLD}', NULL, 800.0000000000, '2026-07-08T18:47:19.618Z'),
        ('${ORG}', '${BRAND}', 'visit_form', '${FEEDBACK}', '${OFFER}', 900.0000000000, '2026-08-20T09:08:29.757Z')
    `);

    const before = await rows();
    await sql.unsafe(MIGRATION);
    // The offer-scoped ceiling is on a DIFFERENT channel, so it supersedes
    // nothing — attribution is never invented across a pair boundary.
    expect(await rows()).toEqual(before);
  });
});
