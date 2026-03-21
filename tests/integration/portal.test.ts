import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks, createStripeAuthError } from "../helpers/mock-stripe.js";

describe("Portal Sessions endpoint", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
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

  describe("POST /v1/portal-sessions", () => {
    it("creates a portal session for account with Stripe customer", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_123",
      });

      const res = await request(app)
        .post("/v1/portal-sessions")
        .set(getAuthHeaders(orgId))
        .send({ return_url: "https://app.example.com/billing" });

      expect(res.status).toBe(200);
      expect(res.body.url).toBe("https://billing.stripe.com/p/session/test_portal");
      expect(stripeMocks.createPortalSession).toHaveBeenCalledWith(
        orgId,
        "00000000-0000-0000-0000-000000000099",
        "cus_123",
        "https://app.example.com/billing",
        {}
      );
    });

    it("returns 400 for invalid return_url", async () => {
      await insertTestAccount({ orgId, stripeCustomerId: "cus_123" });

      const res = await request(app)
        .post("/v1/portal-sessions")
        .set(getAuthHeaders(orgId))
        .send({ return_url: "not-a-url" });

      expect(res.status).toBe(400);
    });

    it("returns 400 when missing return_url", async () => {
      await insertTestAccount({ orgId, stripeCustomerId: "cus_123" });

      const res = await request(app)
        .post("/v1/portal-sessions")
        .set(getAuthHeaders(orgId))
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 404 when account does not exist", async () => {
      const res = await request(app)
        .post("/v1/portal-sessions")
        .set(getAuthHeaders(orgId))
        .send({ return_url: "https://app.example.com/billing" });

      expect(res.status).toBe(404);
    });

    it("returns 400 when account has no Stripe customer", async () => {
      await insertTestAccount({ orgId, stripeCustomerId: undefined });

      const res = await request(app)
        .post("/v1/portal-sessions")
        .set(getAuthHeaders(orgId))
        .send({ return_url: "https://app.example.com/billing" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("No Stripe customer");
    });

    it("returns 502 when Stripe key is expired", async () => {
      await insertTestAccount({ orgId, stripeCustomerId: "cus_123" });
      stripeMocks.createPortalSession.mockRejectedValue(
        createStripeAuthError("Expired API Key provided")
      );

      const res = await request(app)
        .post("/v1/portal-sessions")
        .set(getAuthHeaders(orgId))
        .send({ return_url: "https://app.example.com/billing" });

      expect(res.status).toBe(502);
      expect(res.body.error).toBe("Payment provider authentication failed");
    });
  });
});
