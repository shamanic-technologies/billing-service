import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestAccount,
  insertTestPromoGrant,
  closeDb,
} from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  WELCOME_PROMO_CODE,
  INVITE_REWARD_CODE,
  INVITE_WELCOME_CODE,
} from "../../src/db/schema.js";

describe("POST /internal/credits/grant", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  const systemUserId = "00000000-0000-0000-0000-000000000000";
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let fetchRunsOrgUsageTotalSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();

    const runsClient = await import("../../src/lib/runs-client.js");
    fetchRunsOrgUsageTotalSpy = vi.fn().mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-05-27T00:00:00.000Z",
    });
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(
      fetchRunsOrgUsageTotalSpy
    );
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  function authHeaders() {
    return {
      "X-API-Key": "test-api-key",
      "Content-Type": "application/json",
    };
  }

  async function getPromoCodeId(code: string): Promise<string> {
    const [row] = await db
      .select()
      .from(localPromoCodes)
      .where(eq(localPromoCodes.code, code))
      .limit(1);
    if (!row) throw new Error(`promo code missing in test seed: ${code}`);
    return row.id;
  }

  async function getPromosForOrg(targetOrgId: string) {
    return db
      .select()
      .from(localPromos)
      .where(eq(localPromos.orgId, targetOrgId));
  }

  it("T1: virgin org invite_welcome grant inserts billing_accounts + invite_welcome row, balance $25", async () => {
    const res = await request(app)
      .post("/internal/credits/grant")
      .set(authHeaders())
      .send({ orgId, amountCents: 2500, reason: "invite_welcome" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.newBalanceCents).toBe("2500.0000000000");

    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);
    expect(account).toBeDefined();

    const grants = await getPromosForOrg(orgId);
    expect(grants).toHaveLength(1);
    const inviteWelcomeId = await getPromoCodeId(INVITE_WELCOME_CODE);
    expect(grants[0].promoCodeId).toBe(inviteWelcomeId);
    expect(grants[0].amountCents).toBe("2500.0000000000");
    expect(grants[0].userId).toBe(systemUserId);
  });

  it("T2: virgin org invite_reward grant inserts billing_accounts + invite_reward row, balance $25", async () => {
    const res = await request(app)
      .post("/internal/credits/grant")
      .set(authHeaders())
      .send({ orgId, amountCents: 2500, reason: "invite_reward" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.newBalanceCents).toBe("2500.0000000000");

    const grants = await getPromosForOrg(orgId);
    expect(grants).toHaveLength(1);
    const inviteRewardId = await getPromoCodeId(INVITE_REWARD_CODE);
    expect(grants[0].promoCodeId).toBe(inviteRewardId);
  });

  it("T3: invite_welcome override — replaces existing $2 welcome (final $25, not $27)", async () => {
    await insertTestAccount({ orgId });
    await insertTestPromoGrant({
      orgId,
      userId: systemUserId,
      amountCents: 200,
      promoCode: WELCOME_PROMO_CODE,
    });

    const res = await request(app)
      .post("/internal/credits/grant")
      .set(authHeaders())
      .send({ orgId, amountCents: 2500, reason: "invite_welcome" });

    expect(res.status).toBe(200);
    expect(res.body.newBalanceCents).toBe("2500.0000000000");

    const grants = await getPromosForOrg(orgId);
    expect(grants).toHaveLength(1);
    const inviteWelcomeId = await getPromoCodeId(INVITE_WELCOME_CODE);
    expect(grants[0].promoCodeId).toBe(inviteWelcomeId);
    expect(grants[0].amountCents).toBe("2500.0000000000");
  });

  it("T4: double invite_welcome grant is idempotent (balance unchanged)", async () => {
    await request(app)
      .post("/internal/credits/grant")
      .set(authHeaders())
      .send({ orgId, amountCents: 2500, reason: "invite_welcome" });

    const res = await request(app)
      .post("/internal/credits/grant")
      .set(authHeaders())
      .send({ orgId, amountCents: 2500, reason: "invite_welcome" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.newBalanceCents).toBe("2500.0000000000");

    const grants = await getPromosForOrg(orgId);
    expect(grants).toHaveLength(1);
  });

  it("T5: double invite_reward grant is idempotent (balance unchanged)", async () => {
    await request(app)
      .post("/internal/credits/grant")
      .set(authHeaders())
      .send({ orgId, amountCents: 2500, reason: "invite_reward" });

    const res = await request(app)
      .post("/internal/credits/grant")
      .set(authHeaders())
      .send({ orgId, amountCents: 2500, reason: "invite_reward" });

    expect(res.status).toBe(200);
    expect(res.body.newBalanceCents).toBe("2500.0000000000");

    const grants = await getPromosForOrg(orgId);
    expect(grants).toHaveLength(1);
  });

  it("T6: invite_reward is additive — does NOT override welcome ($2 + $25 = $27)", async () => {
    await insertTestAccount({ orgId });
    await insertTestPromoGrant({
      orgId,
      userId: systemUserId,
      amountCents: 200,
      promoCode: WELCOME_PROMO_CODE,
    });

    const res = await request(app)
      .post("/internal/credits/grant")
      .set(authHeaders())
      .send({ orgId, amountCents: 2500, reason: "invite_reward" });

    expect(res.status).toBe(200);
    expect(res.body.newBalanceCents).toBe("2700.0000000000");

    const grants = await getPromosForOrg(orgId);
    expect(grants).toHaveLength(2);
    const codes = await Promise.all([
      getPromoCodeId(WELCOME_PROMO_CODE),
      getPromoCodeId(INVITE_REWARD_CODE),
    ]);
    expect(grants.map((g) => g.promoCodeId).sort()).toEqual(codes.sort());
  });

  it("T7: rejects unknown reason with 400", async () => {
    const res = await request(app)
      .post("/internal/credits/grant")
      .set(authHeaders())
      .send({ orgId, amountCents: 2500, reason: "foo" });

    expect(res.status).toBe(400);
  });

  it("T8: rejects without API key with 401", async () => {
    const res = await request(app)
      .post("/internal/credits/grant")
      .set({ "Content-Type": "application/json" })
      .send({ orgId, amountCents: 2500, reason: "invite_welcome" });

    expect(res.status).toBe(401);
  });

  it("T9: rejects invalid orgId UUID with 400", async () => {
    const res = await request(app)
      .post("/internal/credits/grant")
      .set(authHeaders())
      .send({ orgId: "not-a-uuid", amountCents: 2500, reason: "invite_welcome" });

    expect(res.status).toBe(400);
  });

  it("rejects non-positive amountCents with 400", async () => {
    const res = await request(app)
      .post("/internal/credits/grant")
      .set(authHeaders())
      .send({ orgId, amountCents: 0, reason: "invite_welcome" });

    expect(res.status).toBe(400);
  });

  it("composes balance with paid topups and usage", async () => {
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("10000.0000000000");
    fetchRunsOrgUsageTotalSpy.mockResolvedValue({
      org_id: orgId,
      spent_cents: "1234.5000000000",
      as_of: "2026-05-27T00:00:00.000Z",
    });

    const res = await request(app)
      .post("/internal/credits/grant")
      .set(authHeaders())
      .send({ orgId, amountCents: 2500, reason: "invite_reward" });

    expect(res.status).toBe(200);
    // 10000 paid + 2500 grant − 1234.5 usage = 11265.5
    expect(res.body.newBalanceCents).toBe("11265.5000000000");
  });

  it("returns 502 when stripe-service unavailable (balance compose fails after grant write)", async () => {
    ssMocks.getCustomerByOrg.mockRejectedValue(new Error("stripe-service down"));

    const res = await request(app)
      .post("/internal/credits/grant")
      .set(authHeaders())
      .send({ orgId, amountCents: 2500, reason: "invite_welcome" });

    expect(res.status).toBe(502);

    // Grant write must already have committed — retry will be idempotent.
    const grants = await getPromosForOrg(orgId);
    expect(grants).toHaveLength(1);
  });

  it("returns 502 when runs-service unavailable", async () => {
    fetchRunsOrgUsageTotalSpy.mockRejectedValue(new Error("runs-service down"));

    const res = await request(app)
      .post("/internal/credits/grant")
      .set(authHeaders())
      .send({ orgId, amountCents: 2500, reason: "invite_reward" });

    expect(res.status).toBe(502);

    const grants = await getPromosForOrg(orgId);
    expect(grants).toHaveLength(1);
  });

  it("grant before /v1/accounts prevents welcome from being re-applied", async () => {
    // Simulate api-service ordering: grant called first, then dashboard hits /v1/accounts.
    await request(app)
      .post("/internal/credits/grant")
      .set(authHeaders())
      .send({ orgId, amountCents: 2500, reason: "invite_welcome" });

    const res = await request(app)
      .get("/v1/accounts")
      .set(getAuthHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body.credited_cents).toBe("2500.0000000000");
    // ensureCustomer must NOT fire — billing_accounts row already exists from the grant tx.
    expect(ssMocks.ensureCustomer).not.toHaveBeenCalled();

    const grants = await getPromosForOrg(orgId);
    expect(grants).toHaveLength(1);
  });
});
