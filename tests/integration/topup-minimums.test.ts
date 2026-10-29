/**
 * Per-account top-up minimums (owner 2026-10-13: « tu me soules avec tes limites
 * hardcodées »). Staff opens a prospect's org, grants $5 to test, and lets it top up
 * from $10 with auto-reload at $10. An org staff never touched keeps its offer
 * default ($100 / $5 for match_100, none for legacy).
 *
 * Own file: other suites close the shared connection in `afterAll` (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi, beforeAll } from "vitest";
import { useMatchOfferDefaults, restoreCurrentOfferDefaults } from "../helpers/test-db.js";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import * as runsClient from "../../src/lib/runs-client.js";
import { db } from "../../src/db/index.js";
import { billingAccounts } from "../../src/db/schema.js";
import { configuredReloadFor } from "../../src/lib/free-credit-offer.js";

const staffOrg = "00000000-0000-0000-0000-0000000007b1";
const untouchedOrg = "00000000-0000-0000-0000-0000000007b2";
const legacyOrg = "00000000-0000-0000-0000-0000000007b3";
const person = "11111111-1111-4111-8111-1111111117b1";
const staff = { "x-email": "kevin@distribute.you" };

describe("per-account top-up minimums", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
  });

  // Written against a fresh account of the match_100 era (pre-0093).
  beforeAll(async () => {
    await useMatchOfferDefaults();
  });

  afterAll(async () => {
    await restoreCurrentOfferDefaults();
    await cleanTestData();
    await closeDb();
  });

  const touch = (orgId: string) =>
    request(app).get("/v1/accounts").set(getAuthHeaders(orgId, person));
  const checkout = (orgId: string, amount: number) =>
    request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId, person))
      .send({ success_url: "https://x/s", cancel_url: "https://x/c", topup_amount_cents: amount });
  const autoTopup = (orgId: string, amount: number, threshold: number) =>
    request(app)
      .patch("/v1/accounts/auto_topup")
      .set(getAuthHeaders(orgId, person))
      .send({ topup_amount_cents: amount, topup_threshold_cents: threshold });
  const setMinimums = (orgId: string, body: Record<string, unknown>) =>
    request(app)
      .put("/v1/accounts/topup_minimums")
      .set({ ...getAuthHeaders(orgId, person), ...staff })
      .send(body);

  it("an untouched match_100 org reads its offer default and still refuses below $100", async () => {
    await touch(untouchedOrg);
    const read = await request(app)
      .get("/v1/accounts/topup_minimums")
      .set(getAuthHeaders(untouchedOrg, person));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      free_credit_offer: "match_100",
      topup_minimum_cents: 10000,
      reload_threshold_minimum_cents: 500,
      topup_minimum_source: "offer_default",
      reload_threshold_minimum_source: "offer_default",
      set_by: null,
    });
    const low = await checkout(untouchedOrg, 9900);
    expect(low.status).toBe(400);
    expect(low.body).toMatchObject({ code: "topup_below_minimum", minimum_cents: 10000 });
  });

  it("staff sets $10: a $10 checkout and a $10 auto-reload at a $10 threshold pass, $9 is refused naming $10", async () => {
    await touch(staffOrg);
    const set = await setMinimums(staffOrg, { topup_minimum_cents: 1000 });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      topup_minimum_cents: 1000,
      topup_minimum_source: "account",
      reload_threshold_minimum_cents: 500,
      reload_threshold_minimum_source: "offer_default",
      offer_default_topup_minimum_cents: 10000,
      set_by: "kevin@distribute.you",
    });
    expect(set.body.set_at).toEqual(expect.any(String));

    const low = await checkout(staffOrg, 900);
    expect(low.status).toBe(400);
    expect(low.body).toMatchObject({ code: "topup_below_minimum", minimum_cents: 1000 });
    expect(low.body.error).toContain("$10.00");
    expect((await checkout(staffOrg, 1000)).status).toBe(200);

    const charge = await request(app)
      .post(`/internal/accounts/by-org/${staffOrg}/charge`)
      .set({ "X-API-Key": "test-api-key" })
      .send({ amountCents: 900 });
    expect(charge.status).toBe(400);
    expect(charge.body).toMatchObject({ code: "topup_below_minimum", minimum_cents: 1000 });

    await db.update(billingAccounts).set({ paymentMode: "prepaid" }).where(eq(billingAccounts.orgId, staffOrg));
    ssMocks.hasAttachedCardPm.mockResolvedValue(true);
    const lowReload = await autoTopup(staffOrg, 900, 1000);
    expect(lowReload.status).toBe(400);
    expect(lowReload.body).toMatchObject({ code: "topup_below_minimum", minimum_cents: 1000 });
    const ok = await autoTopup(staffOrg, 1000, 1000);
    expect(ok.status).toBe(200);
    expect(ok.body.topup_amount_cents).toBe(1000);
    expect(ok.body.topup_threshold_cents).toBe(1000);
  });

  it("the stored reload binds at the staff minimum, never clamped back up to $100", async () => {
    await touch(staffOrg);
    await setMinimums(staffOrg, { topup_minimum_cents: 1000, reload_threshold_minimum_cents: 0 });
    const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, staffOrg));
    expect(configuredReloadFor({ ...row, topupAmountCents: 1000, topupThresholdCents: 1000 })).toEqual({
      amountCents: 1000,
      thresholdCents: 1000,
    });
    // Untouched match org: still clamped to $100 / $5.
    await touch(untouchedOrg);
    const [plain] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, untouchedOrg));
    expect(configuredReloadFor({ ...plain, topupAmountCents: 1000, topupThresholdCents: 100 })).toEqual({
      amountCents: 10000,
      thresholdCents: 500,
    });
  });

  it("the threshold minimum is its own setting; null puts a minimum back on the offer default", async () => {
    await touch(staffOrg);
    await setMinimums(staffOrg, { topup_minimum_cents: 1000, reload_threshold_minimum_cents: 1000 });
    await db.update(billingAccounts).set({ paymentMode: "prepaid" }).where(eq(billingAccounts.orgId, staffOrg));
    ssMocks.hasAttachedCardPm.mockResolvedValue(true);
    const low = await autoTopup(staffOrg, 1000, 900);
    expect(low.status).toBe(400);
    expect(low.body).toMatchObject({ code: "topup_threshold_below_minimum", minimum_cents: 1000 });

    const back = await setMinimums(staffOrg, { topup_minimum_cents: null });
    expect(back.body).toMatchObject({
      topup_minimum_cents: 10000,
      topup_minimum_source: "offer_default",
      reload_threshold_minimum_cents: 1000,
    });
    expect((await checkout(staffOrg, 1000)).body.code).toBe("topup_below_minimum");
  });

  it("a legacy org has no minimum until staff sets one", async () => {
    await insertTestAccount({ orgId: legacyOrg });
    const read = await request(app)
      .get(`/internal/accounts/by-org/${legacyOrg}/topup-minimums`)
      .set({ "X-API-Key": "test-api-key" });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ topup_minimum_cents: null, reload_threshold_minimum_cents: null });
    const set = await request(app)
      .put(`/internal/accounts/by-org/${legacyOrg}/topup-minimums`)
      .set({ "X-API-Key": "test-api-key" })
      .send({ topup_minimum_cents: 2000 });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ topup_minimum_cents: 2000, set_by: null });
  });

  it("refuses a bad body, a missing staff email, and an org with no billing account", async () => {
    await touch(staffOrg);
    expect((await setMinimums(staffOrg, {})).status).toBe(400);
    expect((await setMinimums(staffOrg, { topup_minimum_cents: -1 })).status).toBe(400);
    expect((await setMinimums(staffOrg, { topup_minimum_cents: 10.5 })).status).toBe(400);
    const noEmail = await request(app)
      .put("/v1/accounts/topup_minimums")
      .set(getAuthHeaders(staffOrg, person))
      .send({ topup_minimum_cents: 1000 });
    expect(noEmail.status).toBe(400);
    const missing = await setMinimums("00000000-0000-0000-0000-0000000007b9", { topup_minimum_cents: 1000 });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("account_not_found");
  });

  it("a $5 staff grant lands in the balance billing serves", async () => {
    await insertTestAccount({ orgId: legacyOrg });
    const grant = await request(app)
      .post("/v1/credits/grant")
      .set({ "X-API-Key": "test-api-key", "x-org-id": legacyOrg, ...staff, "Content-Type": "application/json" })
      .send({ amountCents: 500, note: "Test credit", idempotencyKey: "prospect-test-5" });
    expect(grant.status).toBe(200);
    expect(grant.body.newBalanceCents).toBe("500.0000000000");
    const res = await touch(legacyOrg);
    expect(res.body.balance_cents).toBe("500.0000000000");
  });
});
