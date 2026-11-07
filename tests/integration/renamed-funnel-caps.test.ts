/**
 * DELETE-POST-PUBLISHED-1107: a step renamed in the catalogue re-keys the funnel ids that
 * spell it. Migration 0096 states each old-id cap again under its new id (history copied),
 * idempotent; `retireRenamedFunnelCaps` clears the old-id row (a history row, nothing
 * deleted from history) once no funnel campaign of the org carries the old id.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "fs";
import { and, asc, eq } from "drizzle-orm";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db, sql } from "../../src/db/index.js";
import { salesFunnelCapChanges, salesFunnelCaps } from "../../src/db/schema.js";
import { renamedFunnelId, retireRenamedFunnelCaps } from "../../src/lib/renamed-funnel-ids.js";
import type { SalesFunnelCampaignsAnswer } from "../../src/lib/funnel-campaigns.js";

const orgId = "00000000-0000-0000-0000-000000001107";
const brandId = "00000000-0000-0000-0000-000000011070";
const offerId = "aaaaaaaa-1107-4107-8107-aaaaaaaaaaaa";
const OLD = "start_to_post_published@threads-post+post_published_to_paid_client";
const NEW = "start_to_threads_post_published@threads-post+threads_post_published_to_paid_client";
const OTHER = "start_to_x_post_published@x+x_post_published_to_paid_client";
const SINCE = new Date("2026-10-28T18:25:11.887Z");
const USER = "cfe148ed-e3d8-40a2-8920-f8c040a81934";

const MIGRATION = readFileSync(new URL("../../drizzle/0096_renamed_step_funnel_caps.sql", import.meta.url), "utf8");
async function runMigration() {
  for (const stmt of MIGRATION.split("--> statement-breakpoint")) await sql.unsafe(stmt);
}

async function seed(id: string) {
  await db.insert(salesFunnelCaps).values({
    orgId,
    brandId,
    offerId,
    salesFunnelId: id,
    maxVolume: 5,
    maxVolumePeriod: "daily",
    maxVolumeSince: SINCE,
    salesFunnelType: "proactive",
    createdAt: SINCE,
    updatedAt: SINCE,
  });
  await db.insert(salesFunnelCapChanges).values({
    orgId,
    brandId,
    offerId,
    salesFunnelId: id,
    maxVolume: 5,
    maxVolumePeriod: "daily",
    changedByUserId: USER,
    changedAt: SINCE,
  });
}

const capsOf = (id: string) =>
  db.select().from(salesFunnelCaps).where(and(eq(salesFunnelCaps.orgId, orgId), eq(salesFunnelCaps.salesFunnelId, id)));
const historyOf = (id: string) =>
  db
    .select()
    .from(salesFunnelCapChanges)
    .where(and(eq(salesFunnelCapChanges.orgId, orgId), eq(salesFunnelCapChanges.salesFunnelId, id)))
    .orderBy(asc(salesFunnelCapChanges.id));

const campaignsOn = (salesFunnelId: string): (() => Promise<SalesFunnelCampaignsAnswer>) => async () => ({
  ok: true,
  campaigns: [
    { id: "cccccccc-1107-4000-8000-000000000001", brandId, offerId, salesFunnelId, salesFunnelName: null, name: null, status: "ongoing", units: [] },
  ],
});

describe("renamed step: funnel caps re-keyed", () => {
  beforeEach(async () => {
    await cleanTestData();
    await db.delete(salesFunnelCaps).where(eq(salesFunnelCaps.orgId, orgId));
    await db.delete(salesFunnelCapChanges).where(eq(salesFunnelCapChanges.orgId, orgId));
  });
  afterAll(async () => {
    await closeDb();
  });

  it("renames the coarse token only, the same way as the migration's SQL", async () => {
    expect(renamedFunnelId(OLD)).toBe(NEW);
    expect(
      renamedFunnelId("start_to_post_published@threads-post+post_published_to_website_visit+website_visit_to_signup+signup_to_paid_client")
    ).toBe(
      "start_to_threads_post_published@threads-post+threads_post_published_to_website_visit+website_visit_to_signup+signup_to_paid_client"
    );
    for (const untouched of [NEW, OTHER, "start_to_linkedin_post_published@linkedin", "start_to_post_published_extra"]) {
      expect(renamedFunnelId(untouched)).toBeNull();
    }
    const ids = [OLD, NEW, OTHER, "post_published_to_paid_client", "start_to_post_published_extra"];
    const rows = await sql.unsafe<{ id: string; renamed: string }[]>(
      `SELECT id, regexp_replace(id, '(^|[@+]|_to_)post_published(?=$|[@+]|_to_)', '\\1threads_post_published', 'g') AS renamed
       FROM unnest($1::text[]) AS id`,
      [ids]
    );
    for (const r of rows) expect(r.renamed).toBe(renamedFunnelId(r.id) ?? r.id);
  });

  it("migration states the same cap and history under the new id, idempotent, other funnels untouched", async () => {
    await seed(OLD);
    await seed(OTHER);
    await runMigration();
    await runMigration();

    const [old] = await capsOf(OLD);
    const twins = await capsOf(NEW);
    expect(twins).toHaveLength(1);
    const [twin] = twins;
    expect({ ...twin, salesFunnelId: OLD }).toEqual(old);
    expect(await capsOf(OTHER)).toHaveLength(1);
    expect(await capsOf(OTHER.replace("x_post", "threads_post"))).toHaveLength(0);

    const oldHistory = await historyOf(OLD);
    const newHistory = await historyOf(NEW);
    expect(newHistory).toHaveLength(1);
    expect(newHistory.map(({ id: _i, salesFunnelId: _s, ...h }) => h)).toEqual(
      oldHistory.map(({ id: _i, salesFunnelId: _s, ...h }) => h)
    );
  });

  it("keeps the old-id row while a campaign carries the old id", async () => {
    await seed(OLD);
    await runMigration();
    const out = await retireRenamedFunnelCaps(campaignsOn(OLD));
    expect(out.map((o) => o.verdict)).toEqual(["campaign_still_on_old_id"]);
    expect(await capsOf(OLD)).toHaveLength(1);
  });

  it("keeps the old-id row when campaign-service is unreadable or the twin is missing / differs", async () => {
    await seed(OLD);
    expect((await retireRenamedFunnelCaps(campaignsOn(NEW))).map((o) => o.verdict)).toEqual(["twin_missing"]);
    await runMigration();
    expect(
      (await retireRenamedFunnelCaps(async () => ({ ok: false, reason: "campaign_service_unavailable" }))).map((o) => o.verdict)
    ).toEqual(["campaign_service_unreadable"]);
    await db.update(salesFunnelCaps).set({ maxVolume: 7 }).where(eq(salesFunnelCaps.salesFunnelId, NEW));
    expect((await retireRenamedFunnelCaps(campaignsOn(NEW))).map((o) => o.verdict)).toEqual(["twin_differs"]);
    expect(await capsOf(OLD)).toHaveLength(1);
  });

  it("retires the old-id row through a clear once the campaign carries the new id; history kept", async () => {
    await seed(OLD);
    await runMigration();
    const out = await retireRenamedFunnelCaps(campaignsOn(NEW));
    expect(out.map((o) => o.verdict)).toEqual(["retired"]);
    expect(await capsOf(OLD)).toHaveLength(0);
    expect(await capsOf(NEW)).toHaveLength(1);
    const oldHistory = await historyOf(OLD);
    expect(oldHistory).toHaveLength(2);
    expect(oldHistory[1]).toMatchObject({ maxVolume: null, maxVolumePeriod: null, maxBudgetCents: null });
    expect(await retireRenamedFunnelCaps(campaignsOn(NEW))).toEqual([]);
  });
});
