import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  ORG_CREATION_BONUS_CODE,
  WELCOME_PROMO_CODE,
} from "../../src/db/schema.js";
import { sumEntitlementGrantsForOrg } from "../../src/lib/promos.js";

/**
 * Every newly created organization receives $30 of free credit ONCE (migration 0066:
 * the up-front part of "We match your first $100"), granted by billing, under its own
 * ledger reason. It counts toward the org's $100 offer; the per-person welcome gift
 * never stacks on it.
 */
describe("POST /internal/accounts/by-org/:orgId/org-creation-bonus", () => {
  const app = createTestApp();
  const person = "11111111-1111-4111-8111-1111111111b1";
  const firstOrg = "00000000-0000-0000-0000-0000000000b1";
  const secondOrg = "00000000-0000-0000-0000-0000000000b2";
  const internal = { "X-API-Key": "test-api-key" };
  const ZERO = "0.0000000000";
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
    await db
      .update(localPromoCodes)
      .set({ amountCents: 3000 })
      .where(eq(localPromoCodes.code, WELCOME_PROMO_CODE));

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: firstOrg,
      spent_cents: ZERO,
      as_of: "2026-09-27T00:00:00.000Z",
    } as never);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: ZERO,
    } as never);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  const bonus = (orgId: string) =>
    request(app).post(`/internal/accounts/by-org/${orgId}/org-creation-bonus`).set(internal);
  const grants = (orgId: string) =>
    request(app).get("/v1/credits/grants").set({ ...internal, "x-org-id": orgId });

  it("grants $30 once and lists it in the grants ledger under its own reason", async () => {
    const res = await bonus(secondOrg);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      orgId: secondOrg,
      reason: "org_creation_bonus",
      grantedCents: 3000,
      alreadyGranted: false,
    });

    const ledger = await grants(secondOrg);
    expect(ledger.status).toBe(200);
    expect(ledger.body.grants).toHaveLength(1);
    expect(ledger.body.grants[0]).toMatchObject({
      reason: ORG_CREATION_BONUS_CODE,
      amountCents: "3000.0000000000",
      note: "Organization creation bonus: $30.00",
    });
  });

  it("a second request grants nothing (retry never pays twice)", async () => {
    await bonus(secondOrg);
    const again = await bonus(secondOrg);
    expect(again.status).toBe(200);
    expect(again.body.alreadyGranted).toBe(true);
    expect(again.body.grantedCents).toBe(3000);

    const rows = await db.select().from(localPromos).where(eq(localPromos.orgId, secondOrg));
    expect(rows).toHaveLength(1);
  });

  it("creates no billing account and no Stripe customer", async () => {
    await bonus(secondOrg);
    expect(
      await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, secondOrg))
    ).toHaveLength(0);
    expect(ssMocks.ensureCustomer).not.toHaveBeenCalled();
  });

  it("a person's second org gets its own $30 and its own $100 match, never a welcome", async () => {
    // First org: its first billing touch lands its $30 (no welcome).
    const first = await request(app).get("/v1/accounts").set(getAuthHeaders(firstOrg, person));
    expect(first.status).toBe(200);
    expect(first.body.credited_gifted_cents).toBe("3000.0000000000");

    // Second org, bonus asked right after creation, BEFORE its first billing touch.
    const res = await bonus(secondOrg);
    expect(res.body.grantedCents).toBe(3000);

    const second = await request(app).get("/v1/accounts").set(getAuthHeaders(secondOrg, person));
    expect(second.status).toBe(200);
    // The first touch did not add anything on top, and the offer was not zeroed.
    expect(second.body.credited_gifted_cents).toBe("3000.0000000000");
    expect(second.body.free_credit_spendable_cents).toBe("3000.0000000000");
    expect(second.body.free_credit_pending_cents).toBe("7000.0000000000");

    const secondLedger = await grants(secondOrg);
    const reasons = secondLedger.body.grants.map((g: { reason: string }) => g.reason);
    expect(reasons).toEqual([ORG_CREATION_BONUS_CODE]);
    // Neither org's first touch created a Stripe customer.
    expect(ssMocks.ensureCustomer).not.toHaveBeenCalled();
  });

  it("counts toward the free-credit offer (it IS its up-front $30)", async () => {
    await bonus(firstOrg);
    expect(await sumEntitlementGrantsForOrg(firstOrg)).toBe("3000.0000000000");
  });

  it("billing owns the amount: a re-priced code row reaches new grants only", async () => {
    await bonus(firstOrg);
    await db
      .update(localPromoCodes)
      .set({ amountCents: 700 })
      .where(eq(localPromoCodes.code, ORG_CREATION_BONUS_CODE));
    expect((await bonus(secondOrg)).body.grantedCents).toBe(700);
    expect((await bonus(firstOrg)).body.grantedCents).toBe(3000);
  });

  it("fails loud (500) when the seed is missing", async () => {
    await db.delete(localPromoCodes).where(eq(localPromoCodes.code, ORG_CREATION_BONUS_CODE));
    const res = await bonus(firstOrg);
    expect(res.status).toBe(500);
  });

  it("400 on a non-UUID orgId", async () => {
    const res = await bonus("not-a-uuid");
    expect(res.status).toBe(400);
  });
});
