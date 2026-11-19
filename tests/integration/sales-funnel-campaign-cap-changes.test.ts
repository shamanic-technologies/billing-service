/**
 * CAMPAIGN-CHANGE-LOG-1119: the journal of every cap change ONE funnel campaign is held to (its own + the
 * funnel-wide), oldest first. Another funnel campaign's own cap, another funnel or another org is never in it.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { salesFunnelCapChanges } from "../../src/db/schema.js";

const orgId = "00000000-0000-4000-8000-0000000119a1";
const otherOrg = "00000000-0000-4000-8000-0000000119a2";
const brandId = "00000000-0000-4000-8000-000000119b01";
const OFFER = "aaaaaaaa-1119-4119-8119-aaaaaaaaaaaa";
const FUNNEL = "lead_found_to_conversation@sales-cold-email-outreach";
const FC = "cccccccc-0000-4000-8000-0000000119aa";
const FC_OTHER = "cccccccc-0000-4000-8000-0000000119bb";

const app = createTestApp();
const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const path = `/internal/brands/${brandId}/offers/${OFFER}/sales-funnels/${encodeURIComponent(FUNNEL)}/campaigns/${FC}/cap-changes`;

const at = (day: number) => new Date(Date.UTC(2026, 10, day, 12));
const row = (over: Partial<typeof salesFunnelCapChanges.$inferInsert>) => ({
  orgId,
  brandId,
  offerId: OFFER,
  salesFunnelId: FUNNEL,
  maxBudgetCents: "1000",
  maxBudgetPeriod: "daily",
  maxVolume: null,
  maxVolumePeriod: null,
  salesFunnelCampaignId: null,
  changedByUserId: null,
  ...over,
});

beforeEach(async () => {
  await cleanTestData();
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("GET /internal/.../campaigns/:salesFunnelCampaignId/cap-changes", () => {
  it("serves its own and the funnel-wide changes, oldest first; never another campaign's, funnel's or org's", async () => {
    await db.insert(salesFunnelCapChanges).values([
      row({ changedAt: at(3), maxBudgetCents: "2000", salesFunnelCampaignId: FC, changedByUserId: "00000000-0000-4000-8000-0000000119c1" }),
      row({ changedAt: at(1) }),
      row({ changedAt: at(2), maxBudgetCents: null, maxBudgetPeriod: null, maxVolume: 50, maxVolumePeriod: "weekly" }),
      row({ changedAt: at(4), salesFunnelCampaignId: FC_OTHER }),
      row({ changedAt: at(5), salesFunnelId: "other_funnel" }),
      row({ changedAt: at(6), orgId: otherOrg }),
    ]);
    const res = await request(app).get(path).set(internal);
    expect(res.status).toBe(200);
    expect(res.body.salesFunnelCampaignId).toBe(FC);
    expect(res.body.changes.map((c: { changedAt: string; scope: string }) => [c.changedAt, c.scope])).toEqual([
      [at(1).toISOString(), "sales_funnel"],
      [at(2).toISOString(), "sales_funnel"],
      [at(3).toISOString(), "sales_funnel_campaign"],
    ]);
    expect(res.body.changes[1]).toMatchObject({ maxBudget: null, maxVolume: { count: 50, period: "weekly" }, changedByUserId: null });
    expect(res.body.changes[2]).toMatchObject({ maxBudget: { period: "daily" }, changedByUserId: "00000000-0000-4000-8000-0000000119c1" });
    expect(Number(res.body.changes[2].maxBudget.amountCents)).toBe(2000);
  });

  it("refuses a request naming no org", async () => {
    const res = await request(app).get(path).set({ "X-API-Key": "test-api-key" });
    expect(res.status).toBe(400);
  });
});
