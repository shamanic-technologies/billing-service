/**
 * PAYMENT CONSENT (lib/payment-consents, migration 0081): the consent boxes ticked
 * before a first payment are stored when the dashboard sends them, and a call
 * without them works exactly as before.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertTestAccount,
  restoreCurrentOfferDefaults,
  useLegacyOfferDefaults,
} from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { paymentConsents } from "../../src/db/schema.js";

const orgId = "00000000-0000-0000-0000-000000000ac1";
const userId = "00000000-0000-0000-0000-000000000ac9";
const headers = { ...getAuthHeaders(orgId, userId), "x-email": "founder@consent.test" };

const STATEMENTS = [
  "I accept the Terms & Conditions.",
  "To keep using the service, I accept that when my credits run out my account is automatically upgraded to the next plan, under our terms & conditions.",
  "I understand payments are final.",
];
const CONSENT = {
  statements: STATEMENTS,
  terms_version: "2026-10-11",
  accepted_at: "2026-10-11T09:00:00.000Z",
  user_agent: "Mozilla/5.0 test",
};

const REVOLUT_CARD = {
  object: "saved_payment_method",
  org_id: orgId,
  acquirer: "revolut",
  saved: true,
  method: { id: "rpm_1", type: "card", saved_for: "merchant" },
};

describe("payment consent", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeAll(async () => {
    await useLegacyOfferDefaults();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@consent.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.getSavedPaymentMethod.mockResolvedValue(REVOLUT_CARD);
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");
    ssMocks.createCheckoutSession.mockResolvedValue({ url: "https://pay.test/cs", session_id: "cs_1" });
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-10-11T00:00:00.000Z",
    });
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-10-11T00:00:00.000Z",
    });
    await insertTestAccount({ orgId });
  });

  afterAll(async () => {
    await restoreCurrentOfferDefaults();
    await cleanTestData();
    await closeDb();
  });

  it("top-up checkout carrying consent stores it; the read returns it", async () => {
    const res = await request(app).post("/v1/checkout-sessions").set(headers).send({
      success_url: "https://example.com/ok",
      cancel_url: "https://example.com/no",
      topup_amount_cents: 10000,
      consent: CONSENT,
    });
    expect(res.status).toBe(200);
    const read = await request(app)
      .get(`/internal/accounts/by-org/${orgId}/payment-consents`)
      .set({ "X-API-Key": "test-api-key" });
    expect(read.status).toBe(200);
    expect(read.body.consents).toHaveLength(1);
    expect(read.body.consents[0]).toMatchObject({
      org_id: orgId,
      user_id: userId,
      email: "founder@consent.test",
      context: "topup_checkout",
      statements: STATEMENTS,
      terms_version: "2026-10-11",
      accepted_at: "2026-10-11T09:00:00.000Z",
      user_agent: "Mozilla/5.0 test",
      ip_address: null,
    });
  });

  it("a top-up checkout without consent still works and stores nothing", async () => {
    const res = await request(app).post("/v1/checkout-sessions").set(headers).send({
      success_url: "https://example.com/ok",
      cancel_url: "https://example.com/no",
      topup_amount_cents: 10000,
    });
    expect(res.status).toBe(200);
    expect(await db.select().from(paymentConsents)).toHaveLength(0);
  });

  it("subscription checkout and start store consent with their context; without it they still work", async () => {
    const checkout = await request(app)
      .post("/v1/accounts/subscription/checkout_session")
      .set(headers)
      .send({ monthly_amount_cents: 9900, consent: CONSENT });
    expect(checkout.status).toBe(200);
    const start = await request(app)
      .post("/v1/accounts/subscription/start")
      .set(headers)
      .send({ consent: { statements: STATEMENTS, terms_version: "2026-10-11" } });
    expect(start.status).toBe(200);
    expect(start.body.subscription.auto_upgrade).toBe(true);
    const rows = await db.select().from(paymentConsents);
    expect(rows.map((r) => r.context).sort()).toEqual(["subscription_checkout", "subscription_start"]);
    // accepted_at absent = when billing received it.
    const startRow = rows.find((r) => r.context === "subscription_start")!;
    expect(Math.abs(startRow.acceptedAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("a malformed consent is refused (400) and nothing is charged or stored", async () => {
    const res = await request(app).post("/v1/accounts/subscription/start").set(headers).send({
      consent: { statements: [], terms_version: "2026-10-11" },
    });
    expect(res.status).toBe(400);
    expect(await db.select().from(paymentConsents)).toHaveLength(0);
  });
});
