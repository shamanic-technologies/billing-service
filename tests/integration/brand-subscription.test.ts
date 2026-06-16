import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import {
  brandDailyBudgets,
  localPromos,
  welcomeCreditClaims,
  localPromoCodes,
  BRAND_WELCOME_CODE,
} from "../../src/db/schema.js";
import * as subClient from "../../src/lib/subscription-service-client.js";

const orgId = "11111111-0000-4000-8000-000000000001";
const userId = "22222222-0000-4000-8000-000000000001";
const runId = "00000000-0000-0000-0000-00000000baaa";
const brandId = "33333333-0000-4000-8000-000000000001";

const apiKeyHeaders = { "X-API-Key": "test-api-key" };

function subPath(id: string) {
  return `/v1/brands/${id}/subscription`;
}
function cardConfirmedPath(id: string) {
  return `/internal/brands/${id}/subscription/card-confirmed`;
}

async function readBudget(id: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(brandDailyBudgets)
    .where(eq(brandDailyBudgets.brandId, id))
    .limit(1);
  return row ? row.dailyBudgetCents : null;
}

describe("per-brand daily subscription wiring", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders(orgId, userId, runId);

  let createSpy: ReturnType<typeof vi.fn>;
  let updateSpy: ReturnType<typeof vi.fn>;
  let pauseSpy: ReturnType<typeof vi.fn>;
  let resumeSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    setupStripeMocks();
    await cleanTestData();

    // runs-client mock — computeBalance reads it on the card-confirmed path.
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-06-16T00:00:00.000Z",
    });

    // subscription-service-client mocks (stripe-service passthrough).
    createSpy = vi.fn().mockResolvedValue({
      subscriptionId: "sub_mock",
      status: "active",
      dailyAmountCents: 2500,
      brandId,
    });
    updateSpy = vi.fn().mockResolvedValue({
      subscriptionId: "sub_mock",
      status: "active",
      dailyAmountCents: 9900,
      brandId,
    });
    pauseSpy = vi.fn().mockResolvedValue({
      subscriptionId: "sub_mock",
      status: "paused",
      brandId,
    });
    resumeSpy = vi.fn().mockResolvedValue({
      subscriptionId: "sub_mock",
      status: "active",
      dailyAmountCents: 2500,
      brandId,
    });
    vi.spyOn(subClient, "createBrandSubscription").mockImplementation(createSpy);
    vi.spyOn(subClient, "updateBrandSubscriptionAmount").mockImplementation(updateSpy);
    vi.spyOn(subClient, "pauseBrandSubscription").mockImplementation(pauseSpy);
    vi.spyOn(subClient, "resumeBrandSubscription").mockImplementation(resumeSpy);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  // --- Lifecycle: onboard / change / pause / resume ---

  it("onboard at $25/day creates the subscription and sets budget = $25", async () => {
    const res = await request(app)
      .post(subPath(brandId))
      .set(authHeaders)
      .send({ dailyAmountCents: 2500 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      brandId,
      orgId,
      subscriptionId: "sub_mock",
      status: "active",
      dailyAmountCents: 2500,
      dailyBudgetCents: "2500.0000000000",
    });
    expect(createSpy).toHaveBeenCalledWith(brandId, {
      orgId,
      userId,
      dailyAmountCents: 2500,
    });
    expect(await readBudget(brandId)).toBe("2500.0000000000");
  });

  it("change amount updates BOTH the subscription and the budget", async () => {
    await request(app).post(subPath(brandId)).set(authHeaders).send({ dailyAmountCents: 2500 });

    const res = await request(app)
      .patch(subPath(brandId))
      .set(authHeaders)
      .send({ dailyAmountCents: 9900 });

    expect(res.status).toBe(200);
    expect(res.body.dailyAmountCents).toBe(9900);
    expect(res.body.dailyBudgetCents).toBe("9900.0000000000");
    expect(updateSpy).toHaveBeenCalledWith(brandId, 9900);
    expect(await readBudget(brandId)).toBe("9900.0000000000");
  });

  it("pause stops collection and sets the budget to 0", async () => {
    await request(app).post(subPath(brandId)).set(authHeaders).send({ dailyAmountCents: 2500 });

    const res = await request(app)
      .post(`${subPath(brandId)}/pause`)
      .set(authHeaders)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paused");
    expect(res.body.dailyBudgetCents).toBe("0.0000000000");
    expect(pauseSpy).toHaveBeenCalledWith(brandId);
    expect(await readBudget(brandId)).toBe("0.0000000000");
  });

  it("resume restores collection and the budget to the subscription amount", async () => {
    await request(app).post(subPath(brandId)).set(authHeaders).send({ dailyAmountCents: 2500 });
    await request(app).post(`${subPath(brandId)}/pause`).set(authHeaders).send();

    const res = await request(app)
      .post(`${subPath(brandId)}/resume`)
      .set(authHeaders)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
    expect(res.body.dailyAmountCents).toBe(2500);
    expect(res.body.dailyBudgetCents).toBe("2500.0000000000");
    expect(resumeSpy).toHaveBeenCalledWith(brandId);
    expect(await readBudget(brandId)).toBe("2500.0000000000");
  });

  it("propagates a stripe-service failure as 502", async () => {
    createSpy.mockRejectedValueOnce(new Error("stripe-service down"));
    const res = await request(app)
      .post(subPath(brandId))
      .set(authHeaders)
      .send({ dailyAmountCents: 2500 });
    expect(res.status).toBe(502);
  });

  it("rejects a non-UUID brandId with 400", async () => {
    const res = await request(app)
      .post(subPath("not-a-uuid"))
      .set(authHeaders)
      .send({ dailyAmountCents: 2500 });
    expect(res.status).toBe(400);
  });

  it("rejects a non-positive amount with 400", async () => {
    const res = await request(app)
      .post(subPath(brandId))
      .set(authHeaders)
      .send({ dailyAmountCents: 0 });
    expect(res.status).toBe(400);
  });

  it("requires org headers (400 without x-org-id)", async () => {
    const res = await request(app)
      .post(subPath(brandId))
      .set(apiKeyHeaders)
      .send({ dailyAmountCents: 2500 });
    expect(res.status).toBe(400);
  });

  // --- Card-confirmed → one-time $25 grant, 4-key dedup ---

  const card = "fp_card_AAA";
  function confirm(body: {
    brandId?: string;
    orgId?: string;
    userId?: string;
    cardFingerprint?: string;
  }) {
    const path = cardConfirmedPath(body.brandId ?? brandId);
    return request(app)
      .post(path)
      .set(apiKeyHeaders)
      .send({
        orgId: body.orgId ?? orgId,
        userId: body.userId ?? userId,
        cardFingerprint: body.cardFingerprint ?? card,
      });
  }

  it("first card-confirmed grants $25 and records the claim + credit", async () => {
    const res = await confirm({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.granted).toBe(true);
    expect(res.body.amountCents).toBe("2500.0000000000");
    expect(res.body.newBalanceCents).toBe("2500.0000000000");

    const claims = await db
      .select()
      .from(welcomeCreditClaims)
      .where(eq(welcomeCreditClaims.brandId, brandId));
    expect(claims).toHaveLength(1);
    expect(claims[0].cardFingerprint).toBe(card);
    expect(claims[0].localPromoId).not.toBeNull();

    const [code] = await db
      .select()
      .from(localPromoCodes)
      .where(eq(localPromoCodes.code, BRAND_WELCOME_CODE))
      .limit(1);
    const promos = await db
      .select()
      .from(localPromos)
      .where(eq(localPromos.promoCodeId, code.id));
    expect(promos).toHaveLength(1);
    expect(promos[0].amountCents).toBe("2500.0000000000");
  });

  it("a second claim by the same ORG (different brand/user/card) grants $0", async () => {
    await confirm({});
    const res = await confirm({
      brandId: "33333333-0000-4000-8000-0000000000ff",
      userId: "22222222-0000-4000-8000-0000000000ff",
      cardFingerprint: "fp_card_OTHER",
    });
    expect(res.status).toBe(200);
    expect(res.body.granted).toBe(false);
    expect(res.body.amountCents).toBe("0.0000000000");
  });

  it("a second claim by the same USER grants $0", async () => {
    await confirm({});
    const res = await confirm({
      orgId: "11111111-0000-4000-8000-0000000000ff",
      brandId: "33333333-0000-4000-8000-0000000000ee",
      cardFingerprint: "fp_card_USER2",
    });
    expect(res.body.granted).toBe(false);
  });

  it("a second claim for the same BRAND grants $0", async () => {
    await confirm({});
    const res = await confirm({
      orgId: "11111111-0000-4000-8000-0000000000aa",
      userId: "22222222-0000-4000-8000-0000000000aa",
      cardFingerprint: "fp_card_BRAND2",
    });
    expect(res.body.granted).toBe(false);
  });

  it("a second claim with the same CARD fingerprint grants $0", async () => {
    await confirm({});
    const res = await confirm({
      orgId: "11111111-0000-4000-8000-0000000000bb",
      userId: "22222222-0000-4000-8000-0000000000bb",
      brandId: "33333333-0000-4000-8000-0000000000bb",
    });
    expect(res.body.granted).toBe(false);
    // Only ONE credit row exists across all the suppressed attempts.
    const [code] = await db
      .select()
      .from(localPromoCodes)
      .where(eq(localPromoCodes.code, BRAND_WELCOME_CODE))
      .limit(1);
    const promos = await db
      .select()
      .from(localPromos)
      .where(eq(localPromos.promoCodeId, code.id));
    expect(promos).toHaveLength(1);
  });

  it("card-confirmed requires service auth (401 without x-api-key)", async () => {
    const res = await request(app)
      .post(cardConfirmedPath(brandId))
      .send({ orgId, userId, cardFingerprint: card });
    expect(res.status).toBe(401);
  });

  it("card-confirmed rejects a non-UUID orgId in the body with 400", async () => {
    const res = await request(app)
      .post(cardConfirmedPath(brandId))
      .set(apiKeyHeaders)
      .send({ orgId: "nope", userId, cardFingerprint: card });
    expect(res.status).toBe(400);
  });
});
