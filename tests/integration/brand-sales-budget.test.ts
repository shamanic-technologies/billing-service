/**
 * A brand's ONE daily sales budget ("global" mode): stated, read, cleared, and
 * journaled — while a brand that never states one reads exactly as before.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  brandDailyBudgetChanges,
  campaignDailyBudgets,
} from "../../src/db/schema.js";

const orgId = "00000000-0000-0000-0000-0000000054a1";
const otherOrgId = "00000000-0000-0000-0000-0000000054a2";
const userId = "00000000-0000-0000-0000-0000000054a9";
const runId = "00000000-0000-0000-0000-0000000054ab";
const brandId = "00000000-0000-0000-0000-000000054b01";
const OFFER = "aaaaaaaa-1154-4154-8154-aaaaaaaaaaaa";
const COLD = "sales-cold-email-outreach";
const LEG_REPLY = "start_to_conversation";

const app = createTestApp();
const auth = getAuthHeaders(orgId, userId, runId);
const internal = (org: string) => ({ "X-API-Key": "test-api-key", "x-org-id": org });

const salesPath = `/v1/brands/${brandId}/sales-budget`;
const internalSalesPath = `/internal/brands/${brandId}/sales-budget`;
const brandTotalPath = `/internal/brands/${brandId}/daily-budget`;

async function seedCeiling(cents: string) {
  await db.insert(campaignDailyBudgets).values({
    orgId,
    brandId,
    featureSlug: COLD,
    offerId: OFFER,
    legKey: LEG_REPLY,
    dailyBudgetCents: cents,
    updatedAt: new Date(),
  });
}

async function brandTotal(org = orgId) {
  const res = await request(app).get(brandTotalPath).set(internal(org));
  expect(res.status).toBe(200);
  return res.body.dailyBudgetCents as string | null;
}

describe("brand global sales budget", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("a brand that never stated one is in campaigns mode and reads exactly as before", async () => {
    await seedCeiling("700");
    const res = await request(app).get(internalSalesPath).set(internal(orgId));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      brandId,
      orgId,
      mode: "campaigns",
      dailyBudgetCents: null,
      updatedAt: null,
    });
    expect(await brandTotal()).toBe("700.0000000000");
  });

  it("states, reads (user + internal), and the brand total becomes the global amount", async () => {
    await seedCeiling("700");
    const put = await request(app).put(salesPath).set(auth).send({ dailyBudgetCents: 2000 });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      brandId,
      orgId,
      mode: "global",
      dailyBudgetCents: "2000.0000000000",
      previousDailyBudgetCents: null,
    });

    const user = await request(app).get(salesPath).set(auth);
    expect(user.body).toMatchObject({ mode: "global", dailyBudgetCents: "2000.0000000000" });
    const svc = await request(app).get(internalSalesPath).set(internal(orgId));
    expect(svc.body).toMatchObject({ mode: "global", dailyBudgetCents: "2000.0000000000" });

    expect(await brandTotal()).toBe("2000.0000000000");
    // The campaign ceilings are untouched.
    const ceilings = await db.select().from(campaignDailyBudgets);
    expect(ceilings.map((c) => c.dailyBudgetCents)).toEqual(["700.0000000000"]);

    // Another org sharing the brand is unaffected.
    const other = await request(app).get(internalSalesPath).set(internal(otherOrgId));
    expect(other.body.mode).toBe("campaigns");
  });

  it("restating reports the previous amount; clearing returns to the campaign ceilings", async () => {
    await seedCeiling("700");
    await request(app).put(salesPath).set(auth).send({ dailyBudgetCents: 2000 });
    const again = await request(app).put(salesPath).set(auth).send({ dailyBudgetCents: "1500" });
    expect(again.body.previousDailyBudgetCents).toBe("2000.0000000000");

    const del = await request(app).delete(salesPath).set(auth);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({
      mode: "campaigns",
      dailyBudgetCents: null,
      cleared: true,
      previousDailyBudgetCents: "1500.0000000000",
      campaignsDailyBudgetCents: "700.0000000000",
    });
    expect(await brandTotal()).toBe("700.0000000000");

    const again2 = await request(app).delete(salesPath).set(auth);
    expect(again2.body.cleared).toBe(false);

    const hist = await request(app).get(`${salesPath}/history`).set(auth);
    expect(hist.body.history.map((h: { mode: string; dailyBudgetCents: string | null }) => [h.mode, h.dailyBudgetCents])).toEqual([
      ["global", "2000.0000000000"],
      ["global", "1500.0000000000"],
      ["campaigns", null],
    ]);
    const svcHist = await request(app).get(`${internalSalesPath}/history`).set(internal(orgId));
    expect(svcHist.body.history).toHaveLength(3);

    // The brand-total timeline follows the effective total.
    const totals = await db
      .select()
      .from(brandDailyBudgetChanges)
      .where(eq(brandDailyBudgetChanges.brandId, brandId))
      .orderBy(brandDailyBudgetChanges.id);
    expect(totals.map((t) => t.dailyBudgetCents)).toEqual([
      "2000.0000000000",
      "1500.0000000000",
      "700.0000000000",
    ]);
  });

  it("a campaign ceiling written in global mode keeps the brand total on the global amount", async () => {
    await request(app).put(salesPath).set(auth).send({ dailyBudgetCents: 2000 });
    const res = await request(app)
      .put(`/v1/brands/${brandId}/campaign-budget`)
      .set(auth)
      .send({ offerId: OFFER, legKey: LEG_REPLY, featureSlug: COLD, dailyBudgetCents: 900 });
    expect(res.status).toBe(200);
    expect(await brandTotal()).toBe("2000.0000000000");
    const totals = await db
      .select()
      .from(brandDailyBudgetChanges)
      .where(eq(brandDailyBudgetChanges.brandId, brandId));
    expect(totals.map((t) => t.dailyBudgetCents)).toEqual(["2000.0000000000"]);
  });

  it("refuses a brand-scalar write while the brand is in global mode (409)", async () => {
    await request(app).put(salesPath).set(auth).send({ dailyBudgetCents: 2000 });
    const res = await request(app)
      .patch(`/v1/brands/${brandId}/daily-budget`)
      .set(auth)
      .send({ dailyBudgetCents: 500 });
    expect(res.status).toBe(409);
  });

  it("rejects a negative amount and a non-UUID brand", async () => {
    const neg = await request(app).put(salesPath).set(auth).send({ dailyBudgetCents: -1 });
    expect(neg.status).toBe(400);
    const bad = await request(app).get(`/internal/brands/nope/sales-budget`).set(internal(orgId));
    expect(bad.status).toBe(400);
    const noOrg = await request(app).get(internalSalesPath).set({ "X-API-Key": "test-api-key" });
    expect(noOrg.status).toBe(400);
  });

  it("clearing a brand with nothing else configured records a total of 0", async () => {
    await request(app).put(salesPath).set(auth).send({ dailyBudgetCents: 2000 });
    const del = await request(app).delete(salesPath).set(auth);
    expect(del.body.campaignsDailyBudgetCents).toBeNull();
    expect(await brandTotal()).toBeNull();
  });
});
