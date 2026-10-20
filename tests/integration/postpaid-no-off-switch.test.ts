/**
 * A POSTPAID org never loses its credit line to the auto top-up toggle (owner
 * 2026-10-21: « LE CONCEPT DU POST PAID C'EST QUE LE USER PART DE 0, VA EN NEGATIF,
 * ET ON LE CHARGE TOUS LES $50, $200, ETC »). Prod LBVisible: the client clicked the
 * switch OFF, billing read the postpaid org as having no line, and at -$12.18 its
 * campaigns stopped. Turning it back on sent $50, refused under the prepaid $100
 * minimum while the postpaid arming itself writes $50.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { billingAccounts } from "../../src/db/schema.js";
import { _resetCoalescer } from "../../src/lib/reload-coalescer.js";
import { autoTopupArmed } from "../../src/lib/topup-tier.js";

const orgId = "00000000-0000-0000-0000-000000001021";
const campaignId = "00000000-0000-0000-0000-0000000010c1";

describe("postpaid: no off switch on the credit line", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let usage = "0.0000000000";

  beforeEach(async () => {
    vi.restoreAllMocks();
    _resetCoalescer();
    await cleanTestData();
    usage = "0.0000000000";

    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("client@lbv.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("LT");

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage,
      as_of: "2026-10-21T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage,
      as_of: "2026-10-21T00:00:00.000Z",
    }));
    const costs = await import("../../src/lib/costs-client.js");
    vi.spyOn(costs, "resolveRequiredCents").mockResolvedValue("100.0000000000");
  });

  afterAll(async () => {
    await closeDb();
  });

  // LBVisible's state after the click: postpaid, match_100, card on file, flag OFF.
  const insertSwitchedOff = (paymentMode: "postpaid" | "prepaid" = "postpaid") =>
    db
      .insert(billingAccounts)
      .values({ orgId, paymentMode, topupAmountCents: null, topupThresholdCents: null })
      .returning();

  const authorize = () =>
    request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId), "x-campaign-id": campaignId })
      .send({ items: [{ costName: "x", quantity: 1 }] });

  it("a postpaid org with the toggle off still spends below $0 down to its $50 line", async () => {
    await insertSwitchedOff();
    usage = "1218.0000000000"; // -$12.18, the LBVisible balance that stopped
    const res = await authorize();
    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();

    const acct = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(acct.body.has_auto_topup).toBe(true);
    expect(acct.body.topup_threshold_cents).toBe(-5000);
    expect(acct.body.topup_amount_cents).toBe(5000);

    const internal = await request(app)
      .get(`/internal/accounts/by-org/${orgId}/balance`)
      .set({ "X-API-Key": "test-api-key" });
    expect(internal.body.has_auto_topup).toBe(true);
  });

  it("…and is charged $50 when it crosses the line", async () => {
    await insertSwitchedOff();
    usage = "4950.0000000000"; // -$49.50: the next $1 run crosses -$50
    const res = await authorize();
    expect(res.status).toBe(200);
    expect(ssMocks.reloadOffSession).toHaveBeenCalled();
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(5000);
  });

  it("removing the card is still a brake: no card, no line", async () => {
    await insertSwitchedOff();
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
    usage = "1218.0000000000";
    const res = await authorize();
    expect(res.body.sufficient).toBe(false);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("DELETE auto_topup on a postpaid org is refused 409 and changes nothing", async () => {
    await insertTestAccount({ orgId, paymentMode: "postpaid", topupAmountCents: 5000, topupThresholdCents: 0 });
    const res = await request(app).delete("/v1/accounts/auto_topup").set(getAuthHeaders(orgId));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("postpaid_credit_line_required");
    const [acct] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(acct.topupAmountCents).toBe(5000);
    expect(acct.topupThresholdCents).toBe(0);
  });

  it("PATCH auto_topup on a postpaid match_100 org stores the $50 step the arming writes, never refuses it", async () => {
    await db
      .insert(billingAccounts)
      .values({ orgId, paymentMode: "postpaid", freeCreditOffer: "match_100", topupAmountCents: null, topupThresholdCents: null });
    ssMocks.getCustomerByOrgOrNull.mockResolvedValue(customerWithEmail("client@lbv.test"));
    for (const body of [
      { topup_amount_cents: 5000, topup_threshold_cents: 0 },
      { topup_amount_cents: 10000, topup_threshold_cents: 500 },
      { topup_amount_cents: 2000, topup_threshold_cents: 0 },
    ]) {
      const res = await request(app).patch("/v1/accounts/auto_topup").set(getAuthHeaders(orgId)).send(body);
      expect(res.status).toBe(200);
      expect(res.body.topup_amount_cents).toBe(5000);
      expect(res.body.topup_threshold_cents).toBe(-5000);
      const [acct] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
      expect([acct.topupAmountCents, acct.topupThresholdCents]).toEqual([5000, 0]);
    }
  });

  it("PREPAID is unchanged: toggle off stops at $0, DELETE works, the $100 minimum holds", async () => {
    await insertSwitchedOff("prepaid");
    usage = "1218.0000000000";
    const res = await authorize();
    expect(res.body.sufficient).toBe(false);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();

    await db.update(billingAccounts).set({ freeCreditOffer: "match_100" }).where(eq(billingAccounts.orgId, orgId));
    ssMocks.getCustomerByOrgOrNull.mockResolvedValue(customerWithEmail("client@lbv.test"));
    const patch = await request(app)
      .patch("/v1/accounts/auto_topup")
      .set(getAuthHeaders(orgId))
      .send({ topup_amount_cents: 5000, topup_threshold_cents: 500 });
    expect(patch.status).toBe(400);
    expect(patch.body.code).toBe("topup_below_minimum");

    const del = await request(app).delete("/v1/accounts/auto_topup").set(getAuthHeaders(orgId));
    expect(del.status).toBe(200);
  });

  it("autoTopupArmed: postpaid always, subscription never, prepaid by its flag", () => {
    const none = { topupAmountCents: null, topupThresholdCents: null };
    const set = { topupAmountCents: 10000, topupThresholdCents: 500 };
    expect(autoTopupArmed({ paymentMode: "postpaid", ...none })).toBe(true);
    expect(autoTopupArmed({ paymentMode: "subscription", ...set })).toBe(false);
    expect(autoTopupArmed({ paymentMode: "prepaid", ...none })).toBe(false);
    expect(autoTopupArmed({ paymentMode: "prepaid", ...set })).toBe(true);
  });
});
