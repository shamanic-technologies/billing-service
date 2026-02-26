import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

describe("Checkout endpoint", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  const appId = "testapp";
  let stripeMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    stripeMocks = setupStripeMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("creates a checkout session for existing account", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
    });

    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        success_url: "https://app.example.com/success",
        cancel_url: "https://app.example.com/cancel",
        reload_amount_cents: 2000,
      });

    expect(res.status).toBe(200);
    expect(res.body.url).toContain("checkout.stripe.com");
    expect(res.body.session_id).toBe("cs_mock_session");
    expect(stripeMocks.createCheckoutSession).toHaveBeenCalledWith(
      appId,
      "cus_123",
      "https://app.example.com/success",
      "https://app.example.com/cancel",
      2000
    );
  });

  it("auto-creates account if none exists", async () => {
    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        success_url: "https://app.example.com/success",
        cancel_url: "https://app.example.com/cancel",
        reload_amount_cents: 1000,
      });

    expect(res.status).toBe(200);
    expect(stripeMocks.createCustomer).toHaveBeenCalled();
    expect(stripeMocks.createCheckoutSession).toHaveBeenCalled();
  });

  it("validates request body", async () => {
    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({ success_url: "not-a-url" });

    expect(res.status).toBe(400);
  });
});
