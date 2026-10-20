/**
 * The POSTPAID arm of the onboarding A/B test (owner 2026-10-13: « on peut s'inspirer
 * de GAds et remettre du post paid »): a new org saves a card, is charged nothing
 * today, spends on credit, is charged at the $50 line, then $200 / $500, and still
 * receives the "$100 free for $100 paid" match once it has paid $100. A prepaid or
 * Indian card cannot be postpaid (the dashboard asks: switch to prepaid or change card).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, restoreCurrentOfferDefaults } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  ORG_CREATION_BONUS_CODE,
  paymentConsents,
} from "../../src/db/schema.js";
import { _resetCoalescer } from "../../src/lib/reload-coalescer.js";
import { reloadTierFor } from "../../src/lib/topup-tier.js";

const orgId = "00000000-0000-0000-0000-0000000007a1";
const campaignId = "00000000-0000-0000-0000-0000000007c1";

describe("postpaid arm: card saved, nothing charged, Google-Ads credit line, $100 match", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let usage = "0.0000000000";

  beforeEach(async () => {
    vi.restoreAllMocks();
    _resetCoalescer();
    await cleanTestData();
    await restoreCurrentOfferDefaults();
    usage = "0.0000000000";

    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@new.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("FR");

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage,
      as_of: "2026-10-13T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage,
      as_of: "2026-10-13T00:00:00.000Z",
    }));
    const costs = await import("../../src/lib/costs-client.js");
    vi.spyOn(costs, "resolveRequiredCents").mockResolvedValue("100.0000000000");
  });

  afterAll(async () => {
    await closeDb();
  });

  const choosePostpaid = () =>
    request(app)
      .put("/v1/accounts/payment_mode")
      .set(getAuthHeaders(orgId))
      .send({ payment_mode: "postpaid" });

  it("choosing postpaid with a saved card arms the credit line and charges nothing", async () => {
    const res = await choosePostpaid();
    expect(res.status).toBe(200);
    expect(res.body.payment_mode).toBe("postpaid");
    expect(res.body.settled_cents).toBe("0");
    expect(res.body.auto_topup_enabled).toBe(false); // postpaid has no auto top-up; its line is credit_line_*
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();

    const [acct] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(acct.freeCreditOffer).toBe("match_100");
    // Postpaid stores no auto top-up (owner 2026-10-21): its line exists with the card.
    expect(acct.topupAmountCents).toBeNull();

    // Spend runs on credit down to the $50 line: -$45 with a $1 run is still sufficient.
    usage = "4500.0000000000"; // no $30 advance on postpaid: $0 - $45 spend = -$45
    const ok = await request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId), "x-campaign-id": campaignId })
      .send({ items: [{ costName: "x", quantity: 1 }] });
    expect(ok.status).toBe(200);
    expect(ok.body.sufficient).toBe(true);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  const advanceRows = async () =>
    db
      .select({ amountCents: localPromos.amountCents })
      .from(localPromos)
      .innerJoin(localPromoCodes, eq(localPromoCodes.id, localPromos.promoCodeId))
      .where(and(eq(localPromos.orgId, orgId), eq(localPromoCodes.code, ORG_CREATION_BONUS_CODE)));

  it("a postpaid signup ends at balance $0 with no $30 advance, and nothing hands it back", async () => {
    // Org created by its first read: the match_100 $30 advance lands at creation.
    const before = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(before.status).toBe(200);
    expect(before.body.balance_cents).toBe("3000.0000000000");

    const res = await choosePostpaid();
    expect(res.status).toBe(200);

    const after = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(after.body.balance_cents).toBe("0.0000000000");
    expect(after.body.credited_cents).toBe("0.0000000000");
    expect(after.body.credited_advance_cents).toBe("0.0000000000");
    expect((await advanceRows()).map((r) => Number(r.amountCents))).toEqual([0]);

    // Every later grant path stays a no-op: signup, the creation-bonus call, the seed.
    await request(app)
      .post(`/internal/accounts/by-org/${orgId}/signup`)
      .set({ "X-API-Key": "test-api-key" });
    await request(app)
      .post(`/internal/accounts/by-org/${orgId}/org-creation-bonus`)
      .set({ "X-API-Key": "test-api-key" });
    expect((await advanceRows()).map((r) => Number(r.amountCents))).toEqual([0]);
    const final = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(final.body.balance_cents).toBe("0.0000000000");

    // The customer's own ledger lists no "$0 advance" line.
    const grants = await request(app).get("/v1/credits/grants").set(getAuthHeaders(orgId));
    expect(grants.status).toBe(200);
    expect(JSON.stringify(grants.body)).not.toContain("org_creation_bonus");

    // Once it has paid $100, the $100 match is its signup credit.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("10000.0000000000");
    const paid = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(paid.body.credited_cents).toBe("20000.0000000000");
  });

  it("the prepaid arm keeps its $30 advance", async () => {
    await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    const res = await request(app)
      .put("/v1/accounts/payment_mode")
      .set(getAuthHeaders(orgId))
      .send({ payment_mode: "prepaid" });
    expect(res.status).toBe(200);
    expect((await advanceRows()).map((r) => Number(r.amountCents))).toEqual([3000]);
    const acct = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(acct.body.balance_cents).toBe("3000.0000000000");
  });

  it("the consent ticked on the postpaid wall is stored before the switch; malformed is 400", async () => {
    const statements = [
      "Nothing is charged today. I pay what my campaigns spend, never more than their budgets.",
      "I have read and accept the terms and conditions.",
    ];
    const res = await request(app)
      .put("/v1/accounts/payment_mode")
      .set({ ...getAuthHeaders(orgId), "x-email": "founder@new.test" })
      .send({ payment_mode: "postpaid", consent: { statements, terms_version: "2026-10-13" } });
    expect(res.status).toBe(200);
    const rows = await db.select().from(paymentConsents).where(eq(paymentConsents.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].context).toBe("payment_mode_postpaid");
    expect(rows[0].statements).toEqual(statements);
    expect(rows[0].email).toBe("founder@new.test");

    const bad = await request(app)
      .put("/v1/accounts/payment_mode")
      .set(getAuthHeaders(orgId))
      .send({ payment_mode: "postpaid", consent: { statements: [] } });
    expect(bad.status).toBe(400);
  });

  it("the credit line is the ladder ($50, $200, $500), never a stored $100 prepaid reload", () => {
    const stored = { amountCents: 10000, thresholdCents: 500 };
    expect(reloadTierFor("0", "postpaid", stored)).toEqual({ thresholdCents: -5000, amountCents: 5000 });
    expect(reloadTierFor("25000", "postpaid", stored)).toEqual({ thresholdCents: -20000, amountCents: 20000 });
    expect(reloadTierFor("120000", "postpaid", stored)).toEqual({ thresholdCents: -50000, amountCents: 50000 });
    // PREPAID still reloads what it chose.
    expect(reloadTierFor("0", "prepaid", stored)).toEqual(stored);
  });

  it("crossing the $50 line charges $50", async () => {
    await choosePostpaid();
    usage = "8000.0000000000"; // balance -$50: the next $1 run crosses the line
    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId), "x-campaign-id": campaignId })
      .send({ items: [{ costName: "x", quantity: 1 }] });
    expect(res.status).toBe(200);
    expect(ssMocks.reloadOffSession).toHaveBeenCalled();
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(5000);
  });

  it("once it has paid $100, the $100 match lands once", async () => {
    await choosePostpaid();
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("10000.0000000000");
    await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    const rows = await db.select().from(localPromos).where(eq(localPromos.orgId, orgId));
    const match = rows.filter((r) => r.description?.startsWith("First $100 match"));
    expect(match).toHaveLength(1);
    expect(Number(match[0].amountCents)).toBe(10000);
  });

  it("a PREPAID card cannot be postpaid: 409 with the reason, nothing armed", async () => {
    ssMocks.getSavedPaymentMethod.mockResolvedValue({
      object: "saved_payment_method",
      org_id: orgId,
      acquirer: "revolut",
      saved: true,
      method: { id: "pm_r", type: "card", saved_for: "merchant", funding: "prepaid", prepaid: true },
    });
    const res = await choosePostpaid();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("postpaid_card_not_allowed");
    expect(res.body.card_refused_reason).toBe("prepaid_card");
    const [acct] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(acct.topupAmountCents).toBeNull();
  });

  it("an Indian card cannot be postpaid", async () => {
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("IN");
    const res = await choosePostpaid();
    expect(res.status).toBe(409);
    expect(res.body.card_refused_reason).toBe("card_issuing_country_unsupported");
  });

  it("the saved-card read serves prepaid + country + the postpaid verdict, both acquirers", async () => {
    await choosePostpaid();
    ssMocks.getSavedPaymentMethod.mockResolvedValue({
      object: "saved_payment_method",
      org_id: orgId,
      acquirer: "revolut",
      saved: true,
      method: { id: "pm_r", type: "card", saved_for: "merchant", funding: "prepaid", prepaid: true, country: "us" },
    });
    const rev = await request(app).get("/v1/accounts/saved_payment_method").set(getAuthHeaders(orgId));
    expect(rev.status).toBe(200);
    expect(rev.body.acquirer).toBe("revolut");
    expect(rev.body.card_prepaid).toBe(true);
    expect(rev.body.card_country).toBe("US");
    expect(rev.body.postpaid_allowed).toBe(false);
    expect(rev.body.postpaid_refused_reason).toBe("prepaid_card");

    ssMocks.getSavedPaymentMethod.mockResolvedValue({
      object: "saved_payment_method",
      org_id: orgId,
      acquirer: "stripe",
      saved: true,
      method: { id: "pm_s", type: "card", saved_for: "merchant", funding: "debit", prepaid: false },
    });
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("IN");
    const st = await request(app).get("/v1/accounts/saved_payment_method").set(getAuthHeaders(orgId));
    expect(st.body.card_prepaid).toBe(false);
    expect(st.body.card_country).toBe("IN");
    expect(st.body.postpaid_allowed).toBe(false);
    expect(st.body.postpaid_refused_reason).toBe("card_issuing_country_unsupported");
  });
});
