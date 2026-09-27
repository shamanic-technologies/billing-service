import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  brandDailyBudgetChanges,
  brandDailyBudgets,
  brandTransfers,
  campaignAuthorizeCosts,
  campaignDailyBudgets,
  localPromoCodes,
  localPromos,
} from "../../src/db/schema.js";
import { createTestApp } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertTestAccount,
  insertTestPromoCode,
} from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

// A brand moves to another org with its HISTORY, never its MONEY: budgets and
// ceilings follow the brand, credits and payments stay, and both orgs read the
// exact balance they read before — even though runs-service moves the brand's
// cost rows to the target org during the same transfer.
describe("POST /internal/transfer-brand", () => {
  const app = createTestApp();
  const sourceOrgId = "00000000-0000-0000-0000-00000000a001";
  const targetOrgId = "00000000-0000-0000-0000-00000000a002";
  const sourceBrandId = "00000000-0000-0000-0000-00000000b001";
  const otherBrandId = "00000000-0000-0000-0000-00000000b002";
  const targetBrandId = "00000000-0000-0000-0000-00000000b003";
  const userId = "00000000-0000-0000-0000-000000000099";
  const headers = { "X-API-Key": "test-api-key", "Content-Type": "application/json" };

  // What runs-service holds per org (net projected, net actualized) and what it
  // reports its transfer moved. A "runs move" shifts the brand's share between orgs.
  let runsUsage: Record<string, { projected: string; actual: string }>;
  let runsMoved: { usageNetCents: string; actualNetCents: string };
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let movedSpy: ReturnType<typeof vi.fn>;
  let runsTransferSpy: ReturnType<typeof vi.fn>;

  const BRAND_PROJECTED = "559963.3800000000"; // actual + stuck provisioned holds
  const BRAND_ACTUAL = "552795.4400000000";

  function runsMovesTheBrand() {
    runsUsage[sourceOrgId] = { projected: "1000.0000000000", actual: "900.0000000000" };
    runsUsage[targetOrgId] = { projected: BRAND_PROJECTED, actual: BRAND_ACTUAL };
  }

  async function balances(orgId: string) {
    const res = await request(app).get(`/internal/accounts/by-org/${orgId}/balance`).set(headers);
    expect(res.status).toBe(200);
    return { balance: res.body.balance_cents, actual: res.body.actual_balance_cents };
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
    await insertTestAccount({ orgId: sourceOrgId });
    await insertTestAccount({ orgId: targetOrgId });

    // Source: $6,000 paid, the brand's spend plus $10 of other spend on it.
    ssMocks.sumSucceededTopupsForOrg.mockImplementation(async (orgId: string) =>
      orgId === sourceOrgId ? "600000.0000000000" : "0.0000000000"
    );
    runsUsage = {
      [sourceOrgId]: { projected: "560963.3800000000", actual: "553695.4400000000" },
      [targetOrgId]: { projected: "0", actual: "0" },
    };
    runsMoved = { usageNetCents: BRAND_PROJECTED, actualNetCents: BRAND_ACTUAL };

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async (orgId: string) => ({
      org_id: orgId,
      spent_cents: runsUsage[orgId]?.projected ?? "0",
      as_of: "2026-09-27T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async (orgId: string) => ({
      spent_cents: runsUsage[orgId]?.actual ?? "0",
    }));
    movedSpy = vi.fn(async () => runsMoved);
    vi.spyOn(runsClient, "fetchRunsBrandTransferMoved").mockImplementation(movedSpy);
    runsTransferSpy = vi.fn(async () => undefined);
    vi.spyOn(runsClient, "runRunsBrandTransfer").mockImplementation(runsTransferSpy);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  async function seedBrandRows(orgId: string, brandId: string) {
    await db.insert(brandDailyBudgets).values({ orgId, brandId, dailyBudgetCents: "11900" });
    await db.insert(brandDailyBudgetChanges).values([
      { orgId, brandId, dailyBudgetCents: "5000" },
      { orgId, brandId, dailyBudgetCents: "11900" },
    ]);
    await db.insert(campaignDailyBudgets).values([
      { orgId, brandId, featureSlug: "sales-cold-email-outreach", offerId: "00000000-0000-0000-0000-0000000000f1", legKey: "start_to_conversation", dailyBudgetCents: "10700" },
      { orgId, brandId, featureSlug: "ai-meeting-booking", offerId: null, legKey: null, dailyBudgetCents: "200" },
    ]);
  }

  it("keeps BOTH orgs' balances unchanged to the cent, whichever order runs-service moves in", async () => {
    const sourceBefore = await balances(sourceOrgId);
    const targetBefore = await balances(targetOrgId);

    // runs-service moved first (brand-service fans out in parallel).
    runsMovesTheBrand();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });
    expect(res.status).toBe(200);

    expect(await balances(sourceOrgId)).toEqual(sourceBefore);
    expect(await balances(targetOrgId)).toEqual(targetBefore);
    expect(targetBefore).toEqual({ balance: "0.0000000000", actual: "0.0000000000" });
    expect(res.body.balanceAdjustment).toMatchObject({
      movedUsageNetCents: BRAND_PROJECTED,
      movedActualNetCents: BRAND_ACTUAL,
    });
  });

  it("records an auditable ledger row: which brand, from and to which org, when, how much", async () => {
    runsMovesTheBrand();
    await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId });

    const rows = await db.select().from(brandTransfers);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceOrgId,
      sourceBrandId,
      targetOrgId,
      targetBrandId,
      movedUsageNetCents: BRAND_PROJECTED,
      movedActualNetCents: BRAND_ACTUAL,
    });
    expect(rows[0].transferredAt).toBeInstanceOf(Date);
    expect(movedSpy).toHaveBeenCalledWith({ sourceOrgId, sourceBrandId, targetOrgId, targetBrandId });
    // runs-service's own move is driven to completion BEFORE its ledger is read.
    expect(runsTransferSpy).toHaveBeenCalledWith({ sourceOrgId, sourceBrandId, targetOrgId, targetBrandId });
    expect(runsTransferSpy.mock.invocationCallOrder[0]).toBeLessThan(movedSpy.mock.invocationCallOrder[0]);
  });

  it("moves the brand's budget, its history and its per-campaign ceilings, and only that brand's", async () => {
    await seedBrandRows(sourceOrgId, sourceBrandId);
    await seedBrandRows(sourceOrgId, otherBrandId);

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });
    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "brand_daily_budgets", count: 1 },
      { tableName: "brand_daily_budget_changes", count: 2 },
      { tableName: "campaign_daily_budgets", count: 2 },
      { tableName: "brand_transfers", count: 1 },
    ]);

    const budgets = await db.select().from(brandDailyBudgets);
    expect(budgets.filter((b) => b.brandId === sourceBrandId).map((b) => b.orgId)).toEqual([targetOrgId]);
    expect(budgets.filter((b) => b.brandId === otherBrandId).map((b) => b.orgId)).toEqual([sourceOrgId]);
    const changes = await db.select().from(brandDailyBudgetChanges).where(eq(brandDailyBudgetChanges.brandId, sourceBrandId));
    expect(changes.map((c) => c.orgId)).toEqual([targetOrgId, targetOrgId]);
    const ceilings = await db.select().from(campaignDailyBudgets).where(eq(campaignDailyBudgets.brandId, sourceBrandId));
    expect(ceilings.map((c) => c.orgId)).toEqual([targetOrgId, targetOrgId]);
    // Nothing of the brand is left under the source org.
    const leftover = await db.select().from(campaignDailyBudgets).where(eq(campaignDailyBudgets.orgId, sourceOrgId));
    expect(leftover.every((c) => c.brandId === otherBrandId)).toBe(true);
  });

  it("rewrites the brand id when targetBrandId is given", async () => {
    await seedBrandRows(sourceOrgId, sourceBrandId);
    await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId });

    const [budget] = await db.select().from(brandDailyBudgets);
    expect(budget).toMatchObject({ orgId: targetOrgId, brandId: targetBrandId });
    const ceilings = await db.select().from(campaignDailyBudgets);
    expect(ceilings.every((c) => c.orgId === targetOrgId && c.brandId === targetBrandId)).toBe(true);
    const changes = await db.select().from(brandDailyBudgetChanges);
    expect(changes.every((c) => c.orgId === targetOrgId && c.brandId === targetBrandId)).toBe(true);
  });

  it("re-running is a no-op: nothing moves again, the ledger and both balances stay put", async () => {
    await seedBrandRows(sourceOrgId, sourceBrandId);
    runsMovesTheBrand();
    const body = { sourceBrandId, sourceOrgId, targetOrgId };
    await request(app).post("/internal/transfer-brand").set(headers).send(body);
    const sourceAfterFirst = await balances(sourceOrgId);
    const targetAfterFirst = await balances(targetOrgId);

    const res = await request(app).post("/internal/transfer-brand").set(headers).send(body);
    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "brand_daily_budgets", count: 0 },
      { tableName: "brand_daily_budget_changes", count: 0 },
      { tableName: "campaign_daily_budgets", count: 0 },
      { tableName: "brand_transfers", count: 0 },
    ]);
    expect(await db.select().from(brandTransfers)).toHaveLength(1);
    expect(await balances(sourceOrgId)).toEqual(sourceAfterFirst);
    expect(await balances(targetOrgId)).toEqual(targetAfterFirst);
  });

  it("a re-run that moved MORE (spend made on the source in between) raises the recorded figure", async () => {
    runsMovesTheBrand();
    const body = { sourceBrandId, sourceOrgId, targetOrgId };
    await request(app).post("/internal/transfer-brand").set(headers).send(body);

    runsMoved = { usageNetCents: "560000.0000000000", actualNetCents: "553000.0000000000" };
    const res = await request(app).post("/internal/transfer-brand").set(headers).send(body);
    expect(res.body.updatedTables).toContainEqual({ tableName: "brand_transfers", count: 1 });
    const [row] = await db.select().from(brandTransfers);
    expect(row.movedUsageNetCents).toBe("560000.0000000000");
    expect(row.movedActualNetCents).toBe("553000.0000000000");
  });

  it("moves NO money: credits and Stripe customers stay with the org that holds them", async () => {
    await insertTestPromoCode({ code: "brand-gift", amountCents: 2500 });
    const [code] = await db.select().from(localPromoCodes).where(eq(localPromoCodes.code, "brand-gift"));
    await db.insert(localPromos).values({
      orgId: sourceOrgId,
      userId,
      amountCents: "2500",
      promoCodeId: code.id,
      description: "brand-scoped gift",
      brandIds: [sourceBrandId],
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId });
    expect(res.status).toBe(200);

    const promos = await db.select().from(localPromos);
    expect(promos).toHaveLength(1);
    expect(promos[0]).toMatchObject({ orgId: sourceOrgId, brandIds: [sourceBrandId] });
    expect(res.body.updatedTables.map((t: { tableName: string }) => t.tableName)).not.toContain("local_promos");
    expect(res.body.updatedTables.map((t: { tableName: string }) => t.tableName)).not.toContain("stripe_service_customers");
  });

  it("502 and nothing written when runs-service cannot say what it moved", async () => {
    await seedBrandRows(sourceOrgId, sourceBrandId);
    movedSpy.mockRejectedValue(new Error("runs down"));

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });
    expect(res.status).toBe(502);
    expect(await db.select().from(brandTransfers)).toHaveLength(0);
    const [budget] = await db.select().from(brandDailyBudgets);
    expect(budget.orgId).toBe(sourceOrgId);
  });

  it("409 and nothing moved when the target already holds the brand's budget", async () => {
    await seedBrandRows(sourceOrgId, sourceBrandId);
    await db.insert(brandDailyBudgets).values({ orgId: targetOrgId, brandId: targetBrandId, dailyBudgetCents: "100" });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId });
    expect(res.status).toBe(409);
    // Refused before runs-service was asked to move any cost row.
    expect(runsTransferSpy).not.toHaveBeenCalled();
    expect(await db.select().from(brandTransfers)).toHaveLength(0);
    const ceilings = await db.select().from(campaignDailyBudgets);
    expect(ceilings.every((c) => c.orgId === sourceOrgId)).toBe(true);
  });

  it("400 on a malformed body and on source == target", async () => {
    const bad = await request(app).post("/internal/transfer-brand").set(headers).send({ sourceBrandId });
    expect(bad.status).toBe(400);
    const same = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ sourceBrandId, sourceOrgId, targetOrgId: sourceOrgId });
    expect(same.status).toBe(409);
  });

  it("affordability gates a moved campaign on the org campaign-service names, not the stored one", async () => {
    const campaignId = "00000000-0000-0000-0000-0000000c0001";
    await db.insert(campaignAuthorizeCosts).values({
      campaignId,
      orgId: sourceOrgId,
      lastAuthorizeRequiredCents: "50",
    });
    // Source is funded, target holds nothing: the verdict must be the target's.
    runsUsage[sourceOrgId] = { projected: "0", actual: "0" };

    const res = await request(app)
      .get(`/internal/campaigns/${campaignId}/affordability`)
      .set({ ...headers, "x-org-id": targetOrgId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ affordable: false, balanceCents: "0.0000000000" });

    const stored = await request(app).get(`/internal/campaigns/${campaignId}/affordability`).set(headers);
    expect(stored.body.affordable).toBe(true);
  });
});
