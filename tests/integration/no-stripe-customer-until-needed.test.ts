import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, useLegacyOfferDefaults, restoreCurrentOfferDefaults } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import * as ssClient from "../../src/lib/stripe-service-client.js";
import type { StripeCustomer } from "../../src/lib/stripe-service-client.js";

/**
 * A new org gets a Stripe customer only when it actually deals with Stripe.
 *
 * Until 2026-09-27 the first read of an org's billing account created a live
 * Stripe customer carrying the acting person's email — five in one afternoon
 * for one founder creating orgs from the "New organization" modal, orgs that
 * pay through Revolut or run on free credit with no card at all.
 *
 * stripe-service is modelled as holding NO customer until `POST /v1/customers`
 * (ensureCustomer) is called, which is the production state of a new org.
 */
describe("a new org has no Stripe customer until a Stripe flow needs one", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-0000000000d1";
  const userId = "00000000-0000-0000-0000-0000000000d9";
  const headers = getAuthHeaders(orgId, userId);
  const serviceHeaders = { "X-API-Key": "test-api-key", "Content-Type": "application/json" };
  const urls = {
    success_url: "https://example.com/success",
    cancel_url: "https://example.com/cancel",
  };
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
      url: "https://checkout.stripe.com/pay/cs_new",
      session_id: "cs_new",
    });
    await cleanTestData();

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-09-27T00:00:00.000Z",
    });
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    });
  });

  // Written against what a freshly created account got before migration 0066
  // (a legacy account): see useLegacyOfferDefaults.
  beforeAll(async () => {
    await useLegacyOfferDefaults();
  });

  afterAll(async () => {
    await restoreCurrentOfferDefaults();
    await cleanTestData();
    await closeDb();
  });

  /** The whole non-Stripe life of a new org: read, credited, set prepaid. */
  async function readCreditAndSetPrepaid() {
    const read = await request(app).get("/v1/accounts").set(headers);
    expect(read.status).toBe(200);
    const bonus = await request(app)
      .post(`/internal/accounts/by-org/${orgId}/org-creation-bonus`)
      .set(serviceHeaders)
      .send({});
    expect(bonus.status).toBe(200);
    const balance = await request(app).get("/v1/accounts/balance").set(headers);
    expect(balance.status).toBe(200);
    const prepaid = await request(app)
      .put("/v1/accounts/payment_mode")
      .set(headers)
      .send({ payment_mode: "prepaid" });
    expect(prepaid.status).toBe(200);
    const promises = await request(app).get("/v1/free-credit-promises").set(headers);
    expect(promises.status).toBe(200);
  }

  it("reading, crediting and setting prepaid creates NO Stripe customer", async () => {
    await readCreditAndSetPrepaid();
    expect(ssMocks.ensureCustomer).not.toHaveBeenCalled();
    expect(stripeCustomer).toBeNull();
  });

  it.each(["/v1/portal-sessions", "/v1/accounts/card_setup"])(
    "the first Stripe card setup (%s) creates exactly one",
    async (path) => {
      await readCreditAndSetPrepaid();
      const first = await request(app)
        .post(path)
        .set(headers)
        .send({ return_url: "https://example.com/billing" });
      expect(first.status).toBe(200);
      const again = await request(app)
        .post(path)
        .set(headers)
        .send({ return_url: "https://example.com/billing" });
      expect(again.status).toBe(200);
      expect(ssMocks.ensureCustomer).toHaveBeenCalledTimes(1);
    }
  );

  it("the first Stripe checkout creates exactly one and checks out on it", async () => {
    await readCreditAndSetPrepaid();
    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(headers)
      .send({ ...urls, topup_amount_cents: 2000 });
    expect(res.status).toBe(200);
    await request(app).post("/v1/checkout-sessions").set(headers).send({ ...urls, mode: "setup" });
    expect(ssMocks.ensureCustomer).toHaveBeenCalledTimes(1);
    expect(ssMocks.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ "x-org-id": orgId }),
      expect.objectContaining({ customer: stripeCustomer!.id })
    );
  });

  describe("an org pinned to Revolut", () => {
    beforeEach(() => {
      ssMocks.getOrgAcquirer.mockResolvedValue("revolut");
      vi.spyOn(ssClient, "pinOrgAcquirer").mockResolvedValue({ pinned: true, acquirer: "revolut" });
    });

    it("never gets a Stripe customer, through declare, card setup and checkout", async () => {
      const declared = await request(app)
        .put("/v1/accounts/acquirer")
        .set(headers)
        .send({ acquirer: "revolut" });
      expect(declared.status).toBe(200);
      await readCreditAndSetPrepaid();

      for (const path of ["/v1/portal-sessions", "/v1/accounts/card_setup"]) {
        const setup = await request(app)
          .post(path)
          .set(headers)
          .send({ return_url: "https://example.com/billing" });
        expect(setup.status).toBe(200);
      }

      ssMocks.createCheckoutSession.mockResolvedValue({
        id: "ord_1",
        presentation: "embedded_widget",
        amount: 2000,
        currency: "usd",
        widget: {
          script_url: "https://merchant.revolut.com/embed.js",
          environment: "prod",
          token: "tok_public",
          save_payment_method_for: "merchant",
        },
      });
      const checkout = await request(app)
        .post("/v1/checkout-sessions")
        .set(headers)
        .send({ ui_mode: "embedded", topup_amount_cents: 2000 });
      expect(checkout.status).toBe(200);
      expect(checkout.body.mode).toBe("embedded_widget");
      const body = ssMocks.createCheckoutSession.mock.calls[0][1];
      expect(body).not.toHaveProperty("customer");

      expect(ssMocks.ensureCustomer).not.toHaveBeenCalled();
      expect(stripeCustomer).toBeNull();
    });
  });

  it("an unreadable acquirer fails the card setup loudly rather than guessing", async () => {
    expect((await request(app).get("/v1/accounts").set(headers)).status).toBe(200);
    ssMocks.getOrgAcquirer.mockRejectedValue(new Error("stripe-service GET 503"));
    const res = await request(app)
      .post("/v1/accounts/card_setup")
      .set(headers)
      .send({ return_url: "https://example.com/billing" });
    expect(res.status).toBe(502);
    expect(ssMocks.ensureCustomer).not.toHaveBeenCalled();
  });
});
