/**
 * Migration 0077, replayed against the real schema: every stored OUTBOUND leg on
 * the legacy spelling moves to the new one, a non-outbound leg keeps its key, no
 * amount moves, a re-run changes nothing, and a campaign holding BOTH spellings
 * makes the migration refuse rather than guess.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "../../src/db/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const MIGRATION = readFileSync(
  new URL("../../drizzle/0077_outbound_leg_keys_new_spelling.sql", import.meta.url),
  "utf8"
);
const STATEMENTS = MIGRATION.split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

const ORG = "00000000-0000-0000-0000-0000000077f1";
const BRAND = "00000000-0000-0000-0000-000000077f01";
const OFFER = "aaaaaaaa-1177-4177-8177-aaaaaaaaaaaa";

async function seed(featureSlug: string, legKey: string, cents: string): Promise<void> {
  await sql`
    INSERT INTO campaign_daily_budgets (org_id, brand_id, feature_slug, offer_id, leg_key, daily_budget_cents)
    VALUES (${ORG}, ${BRAND}, ${featureSlug}, ${OFFER}, ${legKey}, ${cents})
  `;
}

async function runMigration(): Promise<void> {
  await sql.begin(async (tx) => {
    for (const statement of STATEMENTS) await tx.unsafe(statement);
  });
}

async function stored(): Promise<Array<{ feature_slug: string; leg_key: string; daily_budget_cents: string }>> {
  return sql`
    SELECT feature_slug, leg_key, daily_budget_cents::text AS daily_budget_cents
      FROM campaign_daily_budgets WHERE org_id = ${ORG}
     ORDER BY feature_slug, leg_key
  `;
}

describe("migration 0077: outbound leg keys move to the new spelling", () => {
  beforeEach(async () => {
    await cleanTestData();
    await sql`DELETE FROM campaign_daily_budgets WHERE org_id = ${ORG}`;
  });

  afterAll(async () => {
    await sql`DELETE FROM campaign_daily_budgets WHERE org_id = ${ORG}`;
    await closeDb();
  });

  it("renames outbound legacy legs only, moves no money, and is idempotent", async () => {
    await seed("sales-cold-email-outreach", "start_to_conversation", "500");
    await seed("sales-crm-email-outreach", "start_to_website_visit", "300");
    await seed("cold-linkedin-outreach", "start_to_conversation", "200");
    await seed("meta-ads", "start_to_website_visit", "900");
    await seed("sourcing-apollo-cold-filters", "start_to_lead_found", "100");

    await runMigration();
    const after = await stored();
    expect(after).toEqual([
      { feature_slug: "cold-linkedin-outreach", leg_key: "lead_found_to_conversation", daily_budget_cents: "200.0000000000" },
      { feature_slug: "meta-ads", leg_key: "start_to_website_visit", daily_budget_cents: "900.0000000000" },
      { feature_slug: "sales-cold-email-outreach", leg_key: "lead_found_to_conversation", daily_budget_cents: "500.0000000000" },
      { feature_slug: "sales-crm-email-outreach", leg_key: "lead_found_to_website_visit", daily_budget_cents: "300.0000000000" },
      { feature_slug: "sourcing-apollo-cold-filters", leg_key: "start_to_lead_found", daily_budget_cents: "100.0000000000" },
    ]);

    await runMigration();
    expect(await stored()).toEqual(after);
  });

  it("refuses (and moves nothing) when one campaign holds both spellings", async () => {
    await seed("sales-cold-email-outreach", "start_to_conversation", "500");
    await seed("sales-cold-email-outreach", "lead_found_to_conversation", "700");
    await seed("sales-cold-email-outreach", "start_to_website_visit", "100");
    const before = await stored();
    await expect(runMigration()).rejects.toThrow(/hold both spellings/);
    expect(await stored()).toEqual(before);
  });
});
