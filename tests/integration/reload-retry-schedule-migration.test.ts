/**
 * 0043 BACKFILLS rows, so it gets a replay against the real 0042 shape.
 *
 * The backfill is the whole risk: an org already told about a refusal must not
 * be mailed again on the first tick after the deploy, and the schedule must be
 * anchored at the refusal that actually happened rather than at the deploy —
 * otherwise everyone's clock restarts on a deploy and the rungs mean nothing.
 *
 * Own file rather than a describe appended to the sweep suite: that one closes
 * the shared postgres.js connection in afterAll (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import { closeDb } from "../helpers/test-db.js";

const failedOrg = "00000000-0000-0000-0000-0000000000d1";
const succeededOrg = "00000000-0000-0000-0000-0000000000d2";
const REFUSED_AT = "2026-09-17 06:47:44+00";

/** The table exactly as migration 0042 left it. */
async function toPre0043Shape() {
  await db.execute(sql`DROP TABLE IF EXISTS campaign_reload_sweep_attempts`);
  await db.execute(sql`
    CREATE TABLE campaign_reload_sweep_attempts (
      org_id uuid PRIMARY KEY,
      credited_cents_at_attempt numeric(16,10) NOT NULL,
      last_outcome text NOT NULL,
      attempted_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
}

/** Migration 0043, statement for statement. */
async function apply0043() {
  await db.execute(sql`
    ALTER TABLE campaign_reload_sweep_attempts
      ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1`);
  await db.execute(sql`
    ALTER TABLE campaign_reload_sweep_attempts
      ADD COLUMN IF NOT EXISTS first_failed_at timestamp with time zone`);
  await db.execute(sql`
    ALTER TABLE campaign_reload_sweep_attempts
      ADD COLUMN IF NOT EXISTS notified_at timestamp with time zone`);
  await db.execute(sql`
    UPDATE campaign_reload_sweep_attempts
    SET first_failed_at = COALESCE(first_failed_at, attempted_at),
        notified_at = COALESCE(notified_at, attempted_at)
    WHERE last_outcome = 'failed'`);
}

async function readRow(orgId: string) {
  const rows = await db.execute<{
    attempt_count: number;
    first_failed_at: Date | null;
    notified_at: Date | null;
  }>(sql`
    SELECT attempt_count, first_failed_at, notified_at
    FROM campaign_reload_sweep_attempts WHERE org_id = ${orgId}`);
  return (rows as unknown as Record<string, unknown>[])[0];
}

describe("migration 0043 — retry schedule columns", () => {
  beforeEach(async () => {
    await toPre0043Shape();
    await db.execute(sql`
      INSERT INTO campaign_reload_sweep_attempts
        (org_id, credited_cents_at_attempt, last_outcome, attempted_at)
      VALUES
        (${failedOrg}, 22515.0000000000, 'failed', ${REFUSED_AT}),
        (${succeededOrg}, 5000.0000000000, 'succeeded', ${REFUSED_AT})`);
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS campaign_reload_sweep_attempts`);
    await closeDb();
  });

  it("stamps an already-refused org as told, anchored at its own refusal", async () => {
    await apply0043();

    const row = await readRow(failedOrg);
    // Already notified → the first tick after the deploy cannot re-mail them.
    expect(row.notified_at).not.toBeNull();
    // Anchored at the REFUSAL, not at the deploy: otherwise a deploy restarts
    // everyone's clock and +1d/+3d/+7d/+14d measure from nothing.
    expect(new Date(row.first_failed_at as string).toISOString()).toBe(
      new Date(REFUSED_AT).toISOString()
    );
    expect(row.attempt_count).toBe(1);
  });

  it("leaves a SUCCEEDED row with no anchor and no marker", async () => {
    await apply0043();

    const row = await readRow(succeededOrg);
    expect(row.first_failed_at).toBeNull();
    expect(row.notified_at).toBeNull();
  });

  it("is idempotent — a re-apply moves nothing", async () => {
    await apply0043();
    const before = await readRow(failedOrg);

    await apply0043();

    expect(await readRow(failedOrg)).toEqual(before);
  });
});
