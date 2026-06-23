import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { billingAccounts } from "../../src/db/schema.js";

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
        payment_intent_data: {
          metadata: { org_id: orgId },
          setup_future_usage: "off_session",
        },
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

  it("payment-mode: does NOT write auto-topup config without an explicit threshold", async () => {
    await insertTestAccount({ orgId });

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
        topup_amount_cents: 2000,
      });

    expect(res.status).toBe(200);
    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId));
    expect(account.topupAmountCents).toBeNull();
    expect(account.topupThresholdCents).toBe(200);
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

  // --- Setup-mode ($0 card capture) ---

  it("setup-mode: creates a no-charge setup session with no amount", async () => {
    ssMocks.createCheckoutSession.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_setup",
      session_id: "cs_setup",
    });

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        mode: "setup",
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "https://checkout.stripe.com/pay/cs_setup",
      session_id: "cs_setup",
    });
    expect(ssMocks.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ "x-org-id": orgId }),
      {
        mode: "setup",
        currency: "usd",
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
        customer: "cus_mock_123",
        metadata: { org_id: orgId },
      }
    );
    // No charge fields on a setup session.
    const sentBody = ssMocks.createCheckoutSession.mock.calls[0][1];
    expect(sentBody).not.toHaveProperty("line_items");
    expect(sentBody).not.toHaveProperty("payment_intent_data");
  });

  it("setup-mode: does NOT write a topup amount to the account", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 7777 });

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        mode: "setup",
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
      });

    expect(res.status).toBe(200);
    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId));
    expect(account.topupAmountCents).toBe(7777);
  });

  it("setup-mode: returns 502 when stripe-service fails (no charge fallback)", async () => {
    await insertTestAccount({ orgId });
    ssMocks.createCheckoutSession.mockRejectedValue(new Error("SS down"));

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        mode: "setup",
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
      });

    expect(res.status).toBe(502);
    // Never falls back to a charge.
    expect(ssMocks.createPaymentIntent).not.toHaveBeenCalled();
  });

  // --- Embedded mode (in-app iframe, no redirect) ---

  it("embedded: returns client_secret + session_id (no url), no success/cancel URL required", async () => {
    ssMocks.createCheckoutSession.mockResolvedValue({
      client_secret: "cs_test_secret_abc",
      session_id: "cs_emb",
    });

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        ui_mode: "embedded",
        topup_amount_cents: 2000,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      client_secret: "cs_test_secret_abc",
      session_id: "cs_emb",
    });
    expect(res.body).not.toHaveProperty("url");
  });

  it("embedded: proxies a payment session with ui_mode=embedded, redirect_on_completion=never, off-session card, no success/cancel", async () => {
    ssMocks.createCheckoutSession.mockResolvedValue({
      client_secret: "cs_test_secret_abc",
      session_id: "cs_emb",
    });

    await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        ui_mode: "embedded",
        topup_amount_cents: 2000,
      });

    expect(ssMocks.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ "x-org-id": orgId }),
      {
        mode: "payment",
        ui_mode: "embedded",
        redirect_on_completion: "never",
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
        customer: "cus_mock_123",
        metadata: { org_id: orgId },
        payment_intent_data: {
          metadata: { org_id: orgId },
          setup_future_usage: "off_session",
        },
      }
    );
    // Embedded never sends redirect URLs to stripe-service.
    const sentBody = ssMocks.createCheckoutSession.mock.calls[0][1];
    expect(sentBody).not.toHaveProperty("success_url");
    expect(sentBody).not.toHaveProperty("cancel_url");
  });

  it("embedded: auto-creates the billing account with welcome promo on first checkout", async () => {
    ssMocks.createCheckoutSession.mockResolvedValue({
      client_secret: "cs_test_secret_abc",
      session_id: "cs_emb",
    });

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        ui_mode: "embedded",
        topup_amount_cents: 2000,
      });

    expect(res.status).toBe(200);
    expect(ssMocks.ensureCustomer).toHaveBeenCalled();
    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId));
    expect(account).toBeDefined();
  });

  it("embedded: 400 when topup_amount_cents is missing", async () => {
    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({ ui_mode: "embedded" });

    expect(res.status).toBe(400);
  });

  it("embedded: returns 502 when stripe-service fails", async () => {
    await insertTestAccount({ orgId });
    ssMocks.createCheckoutSession.mockRejectedValue(new Error("SS down"));

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        ui_mode: "embedded",
        topup_amount_cents: 2000,
      });

    expect(res.status).toBe(502);
  });
});
