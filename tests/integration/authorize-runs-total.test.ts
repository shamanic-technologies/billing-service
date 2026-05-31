import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestAccount,
  insertTestPromoGrant,
  closeDb,
} from "../helpers/test-db.js";
import {
  setupStripeMocks,
  customerWithDefaultPM,
} from "../helpers/mock-stripe.js";

const orgId = "00000000-0000-0000-0000-00000000a001";
const userId = "00000000-0000-0000-0000-000000000099";

const authorizeBody = {
  items: [{ costName: "anthropic-sonnet-4-5-tokens-input", quantity: 1000 }],
  description: "runs-total authorize test",
};

describe("Customer balance authorize — composed paid topups + local − usage", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let fetchRunsOrgUsageTotalSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();

    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue("10.0000000000");

    const runsClient = await import("../../src/lib/runs-client.js");
    fetchRunsOrgUsageTotalSpy = vi.fn().mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-05-13T00:00:00.000Z",
    });
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(
      fetchRunsOrgUsageTotalSpy
    );
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("sufficient when paid topups + local credits − usage covers required", async () => {
    await insertTestAccount({ orgId });
    await insertTestPromoGrant({ orgId, userId, amountCents: 100, promoCode: "welcome" });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");
    fetchRunsOrgUsageTotalSpy.mockResolvedValue({
      org_id: orgId,
      spent_cents: "40.0000000000",
      as_of: "x",
    });

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId, userId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);
    // available = 0 + 100 − 40 = 60
    expect(res.body.balance_cents).toBe("60.0000000000");
    expect(res.body.required_cents).toBe("10.0000000000");
    expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
  });

  it("insufficient + no topup config → returns sufficient:false without reload", async () => {
    await insertTestAccount({ orgId });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId, userId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
    expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
  });

  it("insufficient + topup configured + SS has PM → calls reload and re-evaluates", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 1000 });
    ssMocks.getCustomerByOrg.mockResolvedValue(customerWithDefaultPM());
    ssMocks.sumSucceededTopupsForCustomer
      .mockResolvedValueOnce("0.0000000000")
      .mockResolvedValueOnce("1000.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId, userId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);
    expect(ssMocks.reloadViaPaymentIntent).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadViaPaymentIntent.mock.calls[0]?.[1]).toBe(1000);
  });

  it("insufficient + topup + card attached but no default PM → fires reload (regression)", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 1000 });
    // Customer has NO default_payment_method, but a card is attached. The gate now
    // keys on the attached card (hasAttachedCardPm), not invoice_settings.default.
    ssMocks.getCustomerByOrg.mockResolvedValue(customerWithDefaultPM({ invoice_settings: { default_payment_method: null } }));
    ssMocks.hasAttachedCardPm.mockResolvedValue(true);
    ssMocks.sumSucceededTopupsForCustomer
      .mockResolvedValueOnce("0.0000000000")
      .mockResolvedValueOnce("1000.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId, userId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);
    expect(ssMocks.reloadViaPaymentIntent).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadViaPaymentIntent.mock.calls[0]?.[1]).toBe(1000);
  });

  it("insufficient + topup + no card attached → graceful sufficient:false, no reload", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 1000 });
    ssMocks.hasAttachedCardPm.mockResolvedValue(false);
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId, userId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
    expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
  });

  it("PM lookup errors (stripe-service down) → 502, never silent no-PM", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 1000 });
    ssMocks.hasAttachedCardPm.mockRejectedValue(new Error("stripe-service down"));
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId, userId))
      .send(authorizeBody);

    expect(res.status).toBe(502);
    expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
  });

  it("reload status=failed → sufficient:false", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 1000 });
    ssMocks.getCustomerByOrg.mockResolvedValue(customerWithDefaultPM());
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");
    ssMocks.reloadViaPaymentIntent.mockResolvedValue({
      status: "failed",
      failure_reason: "card_declined",
    });

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId, userId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
  });

  it("reload throws (SS down) → 502", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 1000 });
    ssMocks.getCustomerByOrg.mockResolvedValue(customerWithDefaultPM());
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");
    ssMocks.reloadViaPaymentIntent.mockRejectedValue(new Error("SS down"));

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId, userId))
      .send(authorizeBody);

    expect(res.status).toBe(502);
  });

  it("coalesces concurrent reload calls for same org", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 1000 });
    ssMocks.getCustomerByOrg.mockResolvedValue(customerWithDefaultPM());
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");

    ssMocks.reloadViaPaymentIntent.mockImplementation(
      () =>
        new Promise<{ status: "succeeded"; payment_intent_id: string }>((resolve) => {
          setTimeout(() => resolve({ status: "succeeded", payment_intent_id: "pi_x" }), 100);
        })
    );

    const headers = getAuthHeaders(orgId, userId);
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        request(app)
          .post("/v1/customer_balance/authorize")
          .set(headers)
          .send(authorizeBody)
      )
    );

    for (const r of results) {
      expect(r.status).toBe(200);
    }
    expect(ssMocks.reloadViaPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("fails loud when runs-service unavailable", async () => {
    await insertTestAccount({ orgId });
    fetchRunsOrgUsageTotalSpy.mockRejectedValue(new Error("runs-service down"));

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId, userId))
      .send(authorizeBody);

    expect(res.status).toBe(502);
  });
});
