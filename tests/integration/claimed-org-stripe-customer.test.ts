import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import type { StripeCustomer } from "../../src/lib/stripe-service-client.js";

/**
 * A claimed org that started anonymous gets its Stripe customer the first time a
 * flow that NEEDS one runs.
 *
 * The trial seed writes the billing row before any user exists, with no Stripe
 * customer. `findOrCreateAccount` then saw the row and returned early, so the
 * customer was never created, and every checkout for a claimed anonymous org
 * 502'd with "stripe-service returned empty customer list for org" — prod
 * 2026-09-22, org 00673148-…, both the payment and the no-charge setup session.
 *
 * stripe-service is modelled as holding NO customer until `POST /v1/customers`
 * (ensureCustomer) is called, which is exactly the production state.
 */
describe("a claimed org whose billing row exists with no Stripe customer", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-0000000000c1";
  const userId = "00000000-0000-0000-0000-0000000000c9";
  const headers = getAuthHeaders(orgId, userId);
  const serviceHeaders = { "X-API-Key": "test-api-key", "Content-Type": "application/json" };
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let stripeCustomer: StripeCustomer | null;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    stripeCustomer = null;
    ssMocks.getCustomerByOrgOrNull.mockImplementation(async () => stripeCustomer);
    ssMocks.fetchOrgCustomerOrNull.mockImplementation(async () => stripeCustomer);
    ssMocks.ensureCustomer.mockImplementation(async () => {
      stripeCustomer ??= customerWithEmail("founder@example.com");
      return { customer_id: stripeCustomer.id };
    });
    ssMocks.createCheckoutSession.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_claimed",
      session_id: "cs_claimed",
    });
    await cleanTestData();

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-09-22T00:00:00.000Z",
    });
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    });

    // The anonymous phase: the trial seed creates the billing row, no customer.
    const seeded = await request(app)
      .post(`/internal/accounts/by-org/${orgId}/trial-seed`)
      .set(serviceHeaders)
      .send({});
    expect(seeded.status).toBe(200);
    // The claim at signup.
    const signup = await request(app)
      .post(`/internal/accounts/by-org/${orgId}/signup`)
      .set(serviceHeaders)
      .send({});
    expect(signup.status).toBe(200);
    expect(ssMocks.ensureCustomer).not.toHaveBeenCalled();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  const urls = {
    success_url: "https://example.com/success",
    cancel_url: "https://example.com/cancel",
  };

  it("setup-mode checkout creates the customer and returns a url", async () => {
    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(headers)
      .send({ ...urls, mode: "setup" });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://checkout.stripe.com/pay/cs_claimed");
    expect(ssMocks.ensureCustomer).toHaveBeenCalledTimes(1);
    expect(ssMocks.ensureCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ "x-org-id": orgId, "x-user-id": userId })
    );
    expect(ssMocks.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ "x-org-id": orgId }),
      expect.objectContaining({ mode: "setup", customer: "cus_mock_123" })
    );
  });

  it("payment-mode checkout creates the customer and returns a url", async () => {
    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(headers)
      .send({ ...urls, topup_amount_cents: 2000 });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://checkout.stripe.com/pay/cs_claimed");
    expect(ssMocks.ensureCustomer).toHaveBeenCalledTimes(1);
    expect(ssMocks.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ "x-org-id": orgId }),
      expect.objectContaining({ mode: "payment", customer: "cus_mock_123" })
    );
  });

  it("does not create again once the customer exists", async () => {
    await request(app).post("/v1/checkout-sessions").set(headers).send({ ...urls, mode: "setup" });
    const second = await request(app)
      .post("/v1/checkout-sessions")
      .set(headers)
      .send({ ...urls, mode: "setup" });

    expect(second.status).toBe(200);
    expect(ssMocks.ensureCustomer).toHaveBeenCalledTimes(1);
  });

  it("fails loud when stripe-service still holds no customer after the create", async () => {
    ssMocks.ensureCustomer.mockResolvedValue({ customer_id: "cus_ghost" });

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(headers)
      .send({ ...urls, mode: "setup" });

    expect(res.status).toBe(502);
    expect(ssMocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it.each(["/v1/portal-sessions", "/v1/accounts/card_setup"])(
    "%s creates the customer before asking for a card setup",
    async (path) => {
      const res = await request(app)
        .post(path)
        .set(headers)
        .send({ return_url: "https://example.com/billing" });

      expect(res.status).toBe(200);
      expect(ssMocks.ensureCustomer).toHaveBeenCalledTimes(1);
      expect(ssMocks.ensureCustomer.mock.invocationCallOrder[0]).toBeLessThan(
        ssMocks.getCardSetup.mock.invocationCallOrder[0]
      );
    }
  );

  it("reading free-credit promises neither fails nor creates a customer", async () => {
    const res = await request(app).get("/v1/free-credit-promises").set(headers);

    expect(res.status).toBe(200);
    expect(ssMocks.ensureCustomer).not.toHaveBeenCalled();
  });
});
