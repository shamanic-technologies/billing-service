/**
 * RELOAD-RULE-ONE-HOME-1118: billing is the ONE home of the prepaid reload rule.
 * Owner 2026-11-11: each automatic reload ADDS at least $10 (never "threshold + $10").
 * Owner 2026-11-18: the threshold is $0 for everyone, editable nowhere.
 *
 * Worked example: pay $10 -> balance $10; spend to $0 -> card charged $10 -> $10.
 * A caller stating no reload gets exactly that; a caller stating $5 is refused; a
 * threshold a caller sends is ignored.
 *
 * Own file: other suites close the shared connection in `afterAll` (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import * as runsClient from "../../src/lib/runs-client.js";
import { db } from "../../src/db/index.js";
import { billingAccounts } from "../../src/db/schema.js";
import { configuredReloadFor } from "../../src/lib/free-credit-offer.js";

const orgId = "00000000-0000-4000-8000-0000000011a1";
const newOrgId = "00000000-0000-4000-8000-0000000011a2";
const matchOrgId = "00000000-0000-4000-8000-0000000011a3";
const person = "11111111-1111-4111-8111-1111111111a1";
const internal = { "X-API-Key": "test-api-key" };

const urls = { success_url: "https://distribute.you/ok", cancel_url: "https://distribute.you/cancel" };

describe("Prepaid reload rule: one home in billing", () => {
  const app = createTestApp();
  let ss: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ss = setupStripeMocks();
    await cleanTestData();
    const usage = vi.fn().mockResolvedValue({ spent_cents: "0.0000000000" });
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(usage as never);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(usage as never);
    ss.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  const checkout = (id: string, body: Record<string, unknown>) =>
    request(app).post("/v1/accounts/prepaid_checkout").set(getAuthHeaders(id, person)).send({ ...urls, ...body });

  it("serves the rules, even for an org with no billing account: $10 first payment, +$10 at $0", async () => {
    const res = await request(app).get("/v1/accounts/reload_rules").set(getAuthHeaders(newOrgId, person));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      org_id: newOrgId,
      first_topup_minimum_cents: 1000,
      reload_amount_minimum_cents: 1000,
      reload_threshold_minimum_cents: 0,
      default_reload_amount_cents: 1000,
      default_reload_threshold_cents: 0,
    });
    const svc = await request(app).get(`/internal/accounts/by-org/${newOrgId}/reload-rules`).set(internal);
    expect(svc.status).toBe(200);
    expect(svc.body).toEqual(res.body);
    // A read creates nothing.
    expect(await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, newOrgId))).toHaveLength(0);
  });

  it("a caller stating NO reload gets the owner's rule: $10 at $0, never $15", async () => {
    await insertTestAccount({ orgId, freeCreditOffer: "prepaid_at_cost", paymentMode: "prepaid" } as never);
    const res = await checkout(orgId, { topup_amount_cents: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.auto_topup).toEqual({ amount_cents: 1000, threshold_cents: 0 });
    const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(row).toMatchObject({ topupAmountCents: 1000, topupThresholdCents: 0 });
    expect(ss.createCheckoutSession.mock.calls[0][1].line_items[0].price_data.unit_amount).toBe(1000);
  });

  it("$10 is accepted; a larger reload the person chose is kept; a sent threshold is ignored (stored 0)", async () => {
    await insertTestAccount({ orgId, freeCreditOffer: "prepaid_at_cost", paymentMode: "prepaid" } as never);
    const ok = await checkout(orgId, { topup_amount_cents: 1000, auto_topup_amount_cents: 1000, auto_topup_threshold_cents: 500 });
    expect(ok.status).toBe(200);
    const big = await checkout(orgId, { topup_amount_cents: 5000, auto_topup_amount_cents: 5000, auto_topup_threshold_cents: 2000 });
    expect(big.status).toBe(200);
    expect(big.body.auto_topup).toEqual({ amount_cents: 5000, threshold_cents: 0 });
    const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(row).toMatchObject({ topupAmountCents: 5000, topupThresholdCents: 0 });
  });

  it("refuses a reload or a first payment below the rule, writing nothing", async () => {
    await insertTestAccount({ orgId, freeCreditOffer: "prepaid_at_cost", paymentMode: "prepaid" } as never);
    const reload = await checkout(orgId, { topup_amount_cents: 1000, auto_topup_amount_cents: 500, auto_topup_threshold_cents: 500 });
    expect(reload.status).toBe(400);
    expect(reload.body).toMatchObject({ code: "reload_below_minimum", minimum_cents: 1000 });
    const first = await checkout(orgId, { topup_amount_cents: 500 });
    expect(first.status).toBe(400);
    expect(first.body).toMatchObject({ code: "topup_below_minimum", minimum_cents: 1000 });
    expect(ss.createCheckoutSession).not.toHaveBeenCalled();
    const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(row.topupAmountCents).toBeNull();
  });

  it("PATCH auto_topup on an at-cost org refuses a $5 reload, accepts $10 with no threshold, ignores a sent one", async () => {
    await insertTestAccount({ orgId, freeCreditOffer: "prepaid_at_cost", paymentMode: "prepaid" } as never);
    const low = await request(app)
      .patch("/v1/accounts/auto_topup")
      .set(getAuthHeaders(orgId, person))
      .send({ topup_amount_cents: 500, topup_threshold_cents: 500 });
    expect(low.status).toBe(400);
    expect(low.body).toMatchObject({ code: "topup_below_minimum", minimum_cents: 1000 });
    const ok = await request(app)
      .patch("/v1/accounts/auto_topup")
      .set(getAuthHeaders(orgId, person))
      .send({ topup_amount_cents: 1000 });
    expect(ok.status).toBe(200);
    const sent = await request(app)
      .patch("/v1/accounts/auto_topup")
      .set(getAuthHeaders(orgId, person))
      .send({ topup_amount_cents: 2000, topup_threshold_cents: 500 });
    expect(sent.status).toBe(200);
    const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(row).toMatchObject({ topupAmountCents: 2000, topupThresholdCents: 0 });
  });

  it("a stored reload below the rule is read at the rule (corrected, never charged lower)", () => {
    const base = { topupMinimumCents: null, reloadThresholdMinimumCents: null };
    expect(
      configuredReloadFor({ ...base, freeCreditOffer: "agent_api", topupAmountCents: 500, topupThresholdCents: 0 })
    ).toEqual({ amountCents: 1000, thresholdCents: 0 });
    expect(
      configuredReloadFor({ ...base, freeCreditOffer: "prepaid_at_cost", topupAmountCents: 1500, topupThresholdCents: 500 })
    ).toEqual({ amountCents: 1500, thresholdCents: 0 });
    expect(
      configuredReloadFor({ ...base, reloadThresholdMinimumCents: 1000, freeCreditOffer: "match_100", topupAmountCents: 10000, topupThresholdCents: 1000 })
    ).toEqual({ amountCents: 10000, thresholdCents: 0 });
    expect(
      configuredReloadFor({ ...base, freeCreditOffer: "legacy", topupAmountCents: 500, topupThresholdCents: 0 })
    ).toBeNull();
  });

  it("match_100 keeps its own $100 reload at $0; a staff top-up override still wins, a threshold override is not read", async () => {
    await insertTestAccount({ orgId: matchOrgId, freeCreditOffer: "match_100" } as never);
    const res = await request(app).get("/v1/accounts/reload_rules").set(getAuthHeaders(matchOrgId, person));
    expect(res.body).toMatchObject({ first_topup_minimum_cents: 10000, reload_amount_minimum_cents: 10000, reload_threshold_minimum_cents: 0 });
    await db.update(billingAccounts).set({ topupMinimumCents: 2000, reloadThresholdMinimumCents: 1000 }).where(eq(billingAccounts.orgId, matchOrgId));
    const over = await request(app).get("/v1/accounts/reload_rules").set(getAuthHeaders(matchOrgId, person));
    expect(over.body).toMatchObject({ first_topup_minimum_cents: 2000, reload_amount_minimum_cents: 2000, default_reload_amount_cents: 2000, reload_threshold_minimum_cents: 0, default_reload_threshold_cents: 0 });
  });
});
