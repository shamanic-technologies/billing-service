import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

describe("POST /v1/checkout-sessions", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("proxies to stripe-service with Stripe-shape payload and returns session", async () => {
    ssMocks.createCheckoutSession.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_abc",
      session_id: "cs_abc",
    });

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
        topup_amount_cents: 2000,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "https://checkout.stripe.com/pay/cs_abc",
      session_id: "cs_abc",
    });
    expect(ssMocks.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ "x-org-id": orgId }),
      {
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Distribute credit top-up" },
              unit_amount: 2000,
            },
            quantity: 1,
          },
        ],
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
        customer: "cus_mock_123",
        metadata: { org_id: orgId },
        payment_intent_data: { metadata: { org_id: orgId } },
      }
    );
  });

  it("resolves Stripe customer before creating checkout session", async () => {
    const callOrder: string[] = [];
    ssMocks.getCustomerByOrg.mockImplementation(async () => {
      callOrder.push("getCustomerByOrg");
      return {
        id: "cus_mock_123",
        object: "customer",
        metadata: {},
        invoice_settings: { default_payment_method: null },
      };
    });
    ssMocks.createCheckoutSession.mockImplementation(async () => {
      callOrder.push("createCheckoutSession");
      return { url: "https://checkout.stripe.com/pay/cs_abc", session_id: "cs_abc" };
    });

    await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
        topup_amount_cents: 2000,
      });

    expect(callOrder).toEqual(["getCustomerByOrg", "createCheckoutSession"]);
  });

  it("auto-creates billing account on first checkout", async () => {
    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
        topup_amount_cents: 2000,
      });

    expect(res.status).toBe(200);
    expect(ssMocks.ensureCustomer).toHaveBeenCalled();
  });

  it("returns 502 when stripe-service fails", async () => {
    await insertTestAccount({ orgId });
    ssMocks.createCheckoutSession.mockRejectedValue(new Error("SS down"));

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
        topup_amount_cents: 2000,
      });

    expect(res.status).toBe(502);
  });

  it("returns 400 for invalid request body", async () => {
    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({});

    expect(res.status).toBe(400);
  });
});
