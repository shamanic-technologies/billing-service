/**
 * A campaign's budget in two parts: outreach (fixed per day) + sourcing (on
 * demand, up to a ceiling). daily_budget_cents stays the max daily spend; the
 * split is one column on the same row (migration 0074, lib/campaign-sourcing).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { readFileSync } from "fs";
import postgres from "postgres";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaignDailyBudgets } from "../../src/db/schema.js";
import { splitOf } from "../../src/lib/campaign-sourcing.js";
import { __primeSalesPathTerms, __resetSalesPathTerms } from "../../src/lib/sales-path-terms.js";

const orgId = "00000000-0000-0000-0000-0000000057e1";
const userId = "00000000-0000-0000-0000-0000000057e9";
const runId = "00000000-0000-0000-0000-0000000057eb";
const brandId = "00000000-0000-0000-0000-000000057e01";
const COLD = "sales-cold-email-outreach";
const OFFER = "aaaaaaaa-1157-4157-8157-aaaaaaaaaaaa";
const LEG = "start_to_conversation";
const key = { offerId: OFFER, legKey: LEG, featureSlug: COLD };

const internalHeaders = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const writePath = `/v1/brands/${brandId}/campaign-budget`;
const readPath = `/internal/brands/${brandId}/campaign-budget`;
const app = createTestApp();

async function seed(dailyBudgetCents: string, sourcingCeilingCents: string | null) {
  await db.insert(campaignDailyBudgets).values({
    orgId,
    brandId,
    ...key,
    dailyBudgetCents,
    sourcingCeilingCents,
    updatedAt: new Date(),
  });
}

function put(body: Record<string, unknown>) {
  return request(app).put(writePath).set(getAuthHeaders(orgId, userId, runId)).send({ ...key, ...body });
}

async function read(query: Record<string, string> = {}) {
  return request(app).get(readPath).query({ ...key, ...query }).set(internalHeaders);
}

describe("campaign sourcing ceiling", () => {
  beforeEach(async () => {
    await cleanTestData();
    // A stated split reads the catalogue (is the sourcing on its own source campaign?).
    __primeSalesPathTerms([], { origins: [], sourceLegKey: "start_to_lead_found", originsByChannel: {} });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetSalesPathTerms();
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("serves the two parts; they add up to the max daily spend", async () => {
    await seed("2000", "900");
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dailyBudgetCents: "2000.0000000000",
      outreachDailyBudgetCents: "1100.0000000000",
      sourcingCeilingCents: "900.0000000000",
      split: true,
      today: null,
    });
  });

  it("an unsplit campaign keeps its whole budget on outreach and states no sourcing ceiling", async () => {
    await seed("2000", null);
    const res = await read();
    expect(res.body).toMatchObject({
      dailyBudgetCents: "2000.0000000000",
      outreachDailyBudgetCents: "2000.0000000000",
      sourcingCeilingCents: null,
      split: false,
    });
  });

  it("nothing funds the campaign: every amount null, split false", async () => {
    const res = await read();
    expect(res.body).toMatchObject({
      dailyBudgetCents: null,
      outreachDailyBudgetCents: null,
      sourcingCeilingCents: null,
      split: false,
    });
  });

  it("the brand-wide list carries both parts per campaign (additive)", async () => {
    await seed("2000", "900");
    const res = await request(app).get(`/internal/brands/${brandId}/campaign-budgets`).set(internalHeaders);
    expect(res.body.dailyBudgetCents).toBe("2000.0000000000");
    expect(res.body.campaigns[0]).toMatchObject({
      dailyBudgetCents: "2000.0000000000",
      outreachDailyBudgetCents: "1100.0000000000",
      sourcingCeilingCents: "900.0000000000",
    });
  });

  it("the per-offer items read carries the daily split on each item (additive)", async () => {
    await seed("2000", "1700");
    __primeSalesPathTerms([
      {
        slug: COLD,
        operatedBy: "platform",
        managed: true,
        stepTransitions: [
          { legKey: LEG, from: null, minimumMonthlyBudgetCents: 9900 },
          { legKey: "start_to_website_visit", from: null, minimumMonthlyBudgetCents: 9900 },
        ],
      },
    ]);
    const res = await request(app)
      .get(`/v1/brands/${brandId}/offers/${OFFER}/campaign-budgets`)
      .query({ campaigns: `${COLD}:start_to_website_visit` })
      .set(getAuthHeaders(orgId, userId, runId));
    expect(res.status).toBe(200);
    const item = res.body.items.find((i: { legKey: string }) => i.legKey === LEG);
    expect(item).toMatchObject({
      dailyBudgetCents: "2000.0000000000",
      outreachDailyBudgetCents: "300.0000000000",
      sourcingCeilingCents: "1700.0000000000",
      split: true,
    });
    const notSet = res.body.items.find((i: { legKey: string }) => i.legKey === "start_to_website_visit");
    expect(notSet).toMatchObject({ outreachDailyBudgetCents: null, sourcingCeilingCents: null, split: false });
  });

  it("a write states the split with the total", async () => {
    const res = await put({ dailyBudgetCents: 2000, sourcingCeilingCents: 900 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dailyBudgetCents: "2000.0000000000",
      outreachDailyBudgetCents: "1100.0000000000",
      sourcingCeilingCents: "900.0000000000",
      split: true,
    });
  });

  it("a write may state the two parts instead; billing sums them", async () => {
    const res = await put({ outreachDailyBudgetCents: 1100, sourcingCeilingCents: 900 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dailyBudgetCents: "2000.0000000000", sourcingCeilingCents: "900.0000000000" });
  });

  it("a write that moves the total without stating the split keeps the share", async () => {
    await seed("2000", "900");
    const res = await put({ dailyBudgetCents: 4000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dailyBudgetCents: "4000.0000000000",
      outreachDailyBudgetCents: "2200.0000000000",
      sourcingCeilingCents: "1800.0000000000",
    });
  });

  it("a total of 0 has no share left; refunding it leaves the campaign unsplit", async () => {
    await seed("2000", "900");
    expect((await put({ dailyBudgetCents: 0 })).body.sourcingCeilingCents).toBe("0.0000000000");
    const res = await put({ dailyBudgetCents: 2000 });
    expect(res.body).toMatchObject({ sourcingCeilingCents: null, split: false });
  });

  it("null clears the split", async () => {
    await seed("2000", "900");
    const res = await put({ dailyBudgetCents: 2000, sourcingCeilingCents: null });
    expect(res.body).toMatchObject({ sourcingCeilingCents: null, outreachDailyBudgetCents: "2000.0000000000" });
  });

  it("refuses a sourcing ceiling above the total, negative, or an ambiguous body", async () => {
    expect((await put({ dailyBudgetCents: 2000, sourcingCeilingCents: 2001 })).status).toBe(400);
    expect((await put({ dailyBudgetCents: 2000, sourcingCeilingCents: -1 })).status).toBe(400);
    expect((await put({ dailyBudgetCents: 2000, outreachDailyBudgetCents: 1100, sourcingCeilingCents: 900 })).status).toBe(400);
    expect((await put({ outreachDailyBudgetCents: 1100 })).status).toBe(400);
    expect((await put({})).status).toBe(400);
  });

  it("the DB refuses a sourcing ceiling above the total", async () => {
    await expect(seed("2000", "2500")).rejects.toThrow();
  });

  it("today's spend: total from the campaign aggregation, sourcing from the lead-serve + list-build subtrees", async () => {
    await seed("2000", "900");
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      expect(url.searchParams.get("campaignIds")).toBe("c1,c2");
      if (url.pathname === "/v1/stats/costs") {
        return Response.json({
          groups: [
            { netTotalCostInUsdCents: "500.5", totalCostInUsdCents: "600" },
            { netTotalCostInUsdCents: "100", totalCostInUsdCents: "100" },
          ],
        });
      }
      if (url.pathname === "/v1/runs") {
        expect(url.searchParams.get("include")).toBe("subtreeCost");
        if (url.searchParams.get("taskName") === "lead-serve") {
          return Response.json({ runs: [{ id: "r1", netTotalCostInUsdCents: "200" }, { id: "r2", netTotalCostInUsdCents: "50.25" }] });
        }
        return Response.json({ runs: [{ id: "r3", netTotalCostInUsdCents: "10" }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const res = await read({ campaignIds: "c1,c2,c1" });
    expect(res.status).toBe(200);
    expect(res.body.today).toMatchObject({
      campaignIds: ["c1", "c2"],
      spentCents: "600.5000000000",
      sourcingSpentCents: "260.2500000000",
      outreachSpentCents: "340.2500000000",
    });
    expect(res.body.today.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(urls.some((u) => u.includes("taskName=audience-companies"))).toBe(true);
  });

  it("a runs-service failure on today's spend is a 502, never a spend of zero", async () => {
    await seed("2000", "900");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    const res = await read({ campaignIds: "c1" });
    expect(res.status).toBe(502);
  });

  it("splitOf: a half-split campaign has no honest ceiling", () => {
    expect(
      splitOf([
        { dailyBudgetCents: "1000", sourcingCeilingCents: "400" },
        { dailyBudgetCents: "1000", sourcingCeilingCents: null },
      ])
    ).toMatchObject({ split: false, sourcingCeilingCents: null, outreachDailyBudgetCents: "2000.0000000000" });
  });

  it("migration 0075 splits a measured row without moving its total, and re-applying touches nothing", async () => {
    // The real row 0075 names for org 308f528f ($20/day, 84.3% sourcing -> $3 + $17).
    const migration = readFileSync(new URL("../../drizzle/0075_campaign_sourcing_ceiling_backfill.sql", import.meta.url), "utf8");
    const statements = migration
      .split("--> statement-breakpoint")
      .map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim())
      .filter(Boolean);
    const target = statements.find((s) => s.includes("308f528f"))!;
    const org = /org_id = '([^']+)'/.exec(target)![1];
    const brand = /brand_id = '([^']+)'/.exec(target)![1];
    const offer = /offer_id = '([^']+)'/.exec(target)![1];
    const leg = /leg_key = '([^']+)'/.exec(target)![1];
    await db.insert(campaignDailyBudgets).values({ orgId: org, brandId: brand, featureSlug: COLD, offerId: offer, legKey: leg, dailyBudgetCents: "2000" });
    // A row whose total moved since the measurement is left alone.
    await db.insert(campaignDailyBudgets).values({ orgId: org, brandId: brand, featureSlug: "ai-meeting-booking", offerId: offer, legKey: "x", dailyBudgetCents: "777" });
    const sql = postgres(process.env.BILLING_SERVICE_DATABASE_URL || "postgresql://test:test@localhost/test", { max: 1 });
    try {
      for (let pass = 0; pass < 2; pass++) for (const s of statements) await sql.unsafe(s);
    } finally {
      await sql.end();
    }
    const rows = (await db.select().from(campaignDailyBudgets)).filter((r) => r.orgId === org);
    const cold = rows.find((r) => r.featureSlug === COLD)!;
    expect(cold.dailyBudgetCents).toBe("2000.0000000000");
    expect(cold.sourcingCeilingCents).toBe("1700.0000000000");
    expect(rows.find((r) => r.legKey === "x")!.sourcingCeilingCents).toBeNull();
    await db.delete(campaignDailyBudgets);
  });

  it("migration 0075 never states a sourcing ceiling above the total it guards on", () => {
    const migration = readFileSync(new URL("../../drizzle/0075_campaign_sourcing_ceiling_backfill.sql", import.meta.url), "utf8");
    const updates = [...migration.matchAll(/SET sourcing_ceiling_cents = ([\d.]+) .*?daily_budget_cents = ([\d.]+) AND/g)];
    expect(updates.length).toBe(26);
    for (const [, src, total] of updates) {
      expect(Number(src)).toBeGreaterThanOrEqual(0);
      expect(Number(src)).toBeLessThanOrEqual(Number(total));
    }
  });
});
