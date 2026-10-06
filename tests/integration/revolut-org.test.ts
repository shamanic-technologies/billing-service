import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, useLegacyOfferDefaults, restoreCurrentOfferDefaults } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

/**
 * Dashboard v2 "New organization": an org declared as paying through Revolut,
 * then paid for PREPAID in the page. billing relays both halves to
 * stripe-service (v0.55.0); a Stripe org must see nothing change.
 */
describe("Revolut-declared org: declare + embedded prepaid top-up", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-0000000000a1";
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
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

  function stubPin(status: number, body: unknown) {
    const realFetch = globalThis.fetch;
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/internal/acquirer/by-org/")) {
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      return realFetch(input as RequestInfo, init);
    });
  }

  it("declare: relays the pin with the creator's email and name, answers the pinned acquirer", async () => {
    const fetchSpy = stubPin(200, {
      object: "org_acquirer",
      org_id: orgId,
      acquirer: "revolut",
      customer_id: "rev_cus_1",
    });

    const res = await request(app)
      .put("/v1/accounts/acquirer")
      .set(getAuthHeaders(orgId))
      .send({ acquirer: "revolut", email: "founder@acme.com", full_name: "Ada Founder" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ org_id: orgId, acquirer: "revolut" });

    const call = fetchSpy.mock.calls.find(([u]) => String(u).includes("/internal/acquirer/by-org/"))!;
    expect(String(call[0])).toBe(`http://localhost:9996/internal/acquirer/by-org/${orgId}`);
    expect(call[1]!.method).toBe("PUT");
    expect(JSON.parse(call[1]!.body as string)).toEqual({
      acquirer: "revolut",
      email: "founder@acme.com",
      full_name: "Ada Founder",
    });
  });

  it("declare: an org holding a Stripe card answers 409, passed through as 409", async () => {
    stubPin(409, { error: "Refusing to move org: it has a chargeable payment method on stripe" });

    const res = await request(app)
      .put("/v1/accounts/acquirer")
      .set(getAuthHeaders(orgId))
      .send({ acquirer: "revolut", email: "founder@acme.com" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("chargeable_card_on_other_acquirer");
    expect(res.body.error).toContain("chargeable payment method");
  });

  it("declare: stripe-service unreachable/erroring is a 502, never a 200 or a 409", async () => {
    stubPin(500, { error: "boom" });

    const res = await request(app)
      .put("/v1/accounts/acquirer")
      .set(getAuthHeaders(orgId))
      .send({ acquirer: "revolut" });

    expect(res.status).toBe(502);
  });

  it("declare: only 'revolut' can be declared", async () => {
    const fetchSpy = stubPin(200, {});
    const res = await request(app)
      .put("/v1/accounts/acquirer")
      .set(getAuthHeaders(orgId))
      .send({ acquirer: "stripe" });

    expect(res.status).toBe(400);
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("/internal/acquirer/"))).toBe(false);
  });

  it("embedded prepaid top-up on a Revolut org answers the widget descriptor (mode embedded_widget)", async () => {
    ssMocks.createCheckoutSession.mockResolvedValue({
      object: "checkout",
      acquirer: "revolut",
      id: "ord_123",
      presentation: "embedded_widget",
      url: null,
      widget: {
        script_url: "https://merchant.revolut.com/embed.js",
        environment: "prod",
        token: "pub_tok_abc",
        save_payment_method_for: "merchant",
      },
      mode: "payment",
      amount: 5000,
      currency: "USD",
      status: "pending",
    });

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({ ui_mode: "embedded", topup_amount_cents: 5000 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      mode: "embedded_widget",
      script_url: "https://merchant.revolut.com/embed.js",
      environment: "prod",
      token: "pub_tok_abc",
      save_payment_method_for: "merchant",
      amount: 5000,
      currency: "USD",
      session_id: "ord_123",
    });
    expect(res.body).not.toHaveProperty("client_secret");
  });

  it("embedded_widget answer without its widget block fails loud (502)", async () => {
    ssMocks.createCheckoutSession.mockResolvedValue({
      object: "checkout",
      id: "ord_123",
      presentation: "embedded_widget",
      url: null,
      mode: "payment",
      amount: 5000,
      currency: "USD",
    });

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({ ui_mode: "embedded", topup_amount_cents: 5000 });

    expect(res.status).toBe(502);
  });

  it("embedded prepaid top-up on a Stripe org is byte-identical to before", async () => {
    ssMocks.createCheckoutSession.mockResolvedValue({
      client_secret: "cs_abc_secret_xyz",
      session_id: "cs_abc",
    });

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({ ui_mode: "embedded", topup_amount_cents: 5000 });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toBe(
      JSON.stringify({ client_secret: "cs_abc_secret_xyz", session_id: "cs_abc" })
    );
  });
});
