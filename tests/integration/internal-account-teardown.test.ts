import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertTestAccount,
  insertTestCampaignCost,
  insertTestEpisode,
  insertTestPromoGrant,
} from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  billingAccounts,
  brandDailyBudgets,
  campaignAuthorizeCosts,
  creditDepletionEpisodes,
  localPromos,
  WELCOME_PROMO_CODE,
} from "../../src/db/schema.js";

const targetOrgId = "aaaaaaaa-0000-4000-8000-000000000001";
const otherOrgId = "bbbbbbbb-0000-4000-8000-000000000001";
const userId = "cccccccc-0000-4000-8000-000000000001";
const otherUserId = "dddddddd-0000-4000-8000-000000000001";
const apiKeyHeaders = { "X-API-Key": "test-api-key" };

function teardownPath(orgId: string) {
  return `/internal/accounts/by-org/${orgId}`;
}

async function orgRowCounts(orgId: string) {
  const [
    accountRows,
    promoRows,
    episodeRows,
    campaignCostRows,
    brandBudgetRows,
  ] = await Promise.all([
    db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId)),
    db.select().from(localPromos).where(eq(localPromos.orgId, orgId)),
    db
      .select()
      .from(creditDepletionEpisodes)
      .where(eq(creditDepletionEpisodes.orgId, orgId)),
    db
      .select()
      .from(campaignAuthorizeCosts)
      .where(eq(campaignAuthorizeCosts.orgId, orgId)),
    db.select().from(brandDailyBudgets).where(eq(brandDailyBudgets.orgId, orgId)),
  ]);

  return {
    billingAccounts: accountRows.length,
    localPromos: promoRows.length,
    creditDepletionEpisodes: episodeRows.length,
    campaignAuthorizeCosts: campaignCostRows.length,
    brandDailyBudgets: brandBudgetRows.length,
    welcomeCreditClaims: 0,
  };
}

async function seedOrgBillingState(orgId: string, seed: "target" | "other") {
  const campaignId =
    seed === "target"
      ? "aaaaaaaa-0000-4000-8000-00000000c001"
      : "bbbbbbbb-0000-4000-8000-00000000c001";
  const brandId =
    seed === "target"
      ? "aaaaaaaa-0000-4000-8000-00000000b001"
      : "bbbbbbbb-0000-4000-8000-00000000b001";

  await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 1000 });
  await insertTestPromoGrant({
    orgId,
    userId: seed === "target" ? userId : otherUserId,
    amountCents: 500,
    promoCode: WELCOME_PROMO_CODE,
  });
  await insertTestEpisode({
    orgId,
    userId: seed === "target" ? userId : otherUserId,
    campaignId,
  });
  await insertTestCampaignCost({
    campaignId,
    orgId,
    lastAuthorizeRequiredCents: "42.0000000000",
  });
  await db.insert(brandDailyBudgets).values({
    brandId,
    orgId,
    dailyBudgetCents: "2500.0000000000",
  });
}

describe("DELETE /internal/accounts/by-org/:orgId", () => {
  const app = createTestApp();

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("deletes billing-owned org state and leaves other orgs untouched", async () => {
    await seedOrgBillingState(targetOrgId, "target");
    await seedOrgBillingState(otherOrgId, "other");

    const res = await request(app).delete(teardownPath(targetOrgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      orgId: targetOrgId,
      deletedRows: {
        billingAccounts: 1,
        localPromos: 1,
        creditDepletionEpisodes: 1,
        campaignAuthorizeCosts: 1,
        brandDailyBudgets: 1,
        welcomeCreditClaims: 0,
      },
    });
    expect(await orgRowCounts(targetOrgId)).toEqual({
      billingAccounts: 0,
      localPromos: 0,
      creditDepletionEpisodes: 0,
      campaignAuthorizeCosts: 0,
      brandDailyBudgets: 0,
      welcomeCreditClaims: 0,
    });
    expect(await orgRowCounts(otherOrgId)).toEqual({
      billingAccounts: 1,
      localPromos: 1,
      creditDepletionEpisodes: 1,
      campaignAuthorizeCosts: 1,
      brandDailyBudgets: 1,
      welcomeCreditClaims: 0,
    });
  });

  it("is idempotent when no billing rows exist for the org", async () => {
    const first = await request(app).delete(teardownPath(targetOrgId)).set(apiKeyHeaders);
    const second = await request(app).delete(teardownPath(targetOrgId)).set(apiKeyHeaders);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.deletedRows).toEqual({
      billingAccounts: 0,
      localPromos: 0,
      creditDepletionEpisodes: 0,
      campaignAuthorizeCosts: 0,
      brandDailyBudgets: 0,
      welcomeCreditClaims: 0,
    });
  });

  it("requires service auth", async () => {
    const res = await request(app).delete(teardownPath(targetOrgId));

    expect(res.status).toBe(401);
  });

  it("rejects a non-UUID orgId", async () => {
    const res = await request(app).delete(teardownPath("not-a-uuid")).set(apiKeyHeaders);

    expect(res.status).toBe(400);
  });

  it("fails loud when the DB transaction fails", async () => {
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("db down") as never);

    const res = await request(app).delete(teardownPath(targetOrgId)).set(apiKeyHeaders);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Failed to delete billing account state");
  });
});
