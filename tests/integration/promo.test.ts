import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestAccount,
  insertTestPromoCode,
  closeDb,
} from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

describe("Promo endpoints", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  const orgId2 = "00000000-0000-0000-0000-000000000002";
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

  describe("POST /v1/promo/redeem", () => {
    it("redeems a valid promo code and credits the account", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_promo",
        creditBalanceCents: 200,
      });
      await insertTestPromoCode({ code: "qr10", amountCents: 800 });

      const res = await request(app)
        .post("/v1/promo/redeem")
        .set(getAuthHeaders(orgId))
        .send({ code: "qr10" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        redeemed: true,
        amount_cents: 800,
        balance_cents: 1000,
      });

      // Stripe balance transaction should be fired
      expect(stripeMocks.createBalanceTransaction).toHaveBeenCalledWith(
        orgId,
        expect.any(String),
        "cus_promo",
        -800,
        "Promo credit: qr10 ($8.00)",
        undefined,
        {}
      );
    });

    it("auto-creates billing account if org has none", async () => {
      await insertTestPromoCode({ code: "welcome10", amountCents: 1000 });

      const res = await request(app)
        .post("/v1/promo/redeem")
        .set(getAuthHeaders(orgId))
        .send({ code: "welcome10" });

      expect(res.status).toBe(200);
      expect(res.body.redeemed).toBe(true);
      // $2 welcome + $10 promo = $12 = 1200 cents
      expect(res.body.balance_cents).toBe(1200);
    });

    it("returns 400 for invalid promo code", async () => {
      await insertTestAccount({ orgId });

      const res = await request(app)
        .post("/v1/promo/redeem")
        .set(getAuthHeaders(orgId))
        .send({ code: "nonexistent" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid promo code");
    });

    it("returns 400 for expired promo code", async () => {
      await insertTestAccount({ orgId });
      await insertTestPromoCode({
        code: "expired",
        amountCents: 500,
        expiresAt: new Date("2020-01-01"),
      });

      const res = await request(app)
        .post("/v1/promo/redeem")
        .set(getAuthHeaders(orgId))
        .send({ code: "expired" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Promo code has expired");
    });

    it("returns 400 when max redemptions reached", async () => {
      await insertTestAccount({ orgId });
      await insertTestAccount({ orgId: orgId2 });
      const promo = await insertTestPromoCode({
        code: "limited",
        amountCents: 500,
        maxRedemptions: 1,
      });

      // First org redeems
      await request(app)
        .post("/v1/promo/redeem")
        .set(getAuthHeaders(orgId2))
        .send({ code: "limited" });

      // Second org tries
      const res = await request(app)
        .post("/v1/promo/redeem")
        .set(getAuthHeaders(orgId))
        .send({ code: "limited" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Promo code has reached its redemption limit");
    });

    it("returns 409 when org already redeemed the code", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_dup",
        creditBalanceCents: 200,
      });
      await insertTestPromoCode({ code: "qr10", amountCents: 800 });

      // First redemption
      await request(app)
        .post("/v1/promo/redeem")
        .set(getAuthHeaders(orgId))
        .send({ code: "qr10" });

      // Duplicate
      const res = await request(app)
        .post("/v1/promo/redeem")
        .set(getAuthHeaders(orgId))
        .send({ code: "qr10" });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe(
        "Promo code already redeemed by this organization"
      );
    });

    it("returns 400 when code is missing from body", async () => {
      const res = await request(app)
        .post("/v1/promo/redeem")
        .set(getAuthHeaders(orgId))
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 401 without API key", async () => {
      const res = await request(app)
        .post("/v1/promo/redeem")
        .set({ "x-org-id": orgId })
        .send({ code: "qr10" });

      expect(res.status).toBe(401);
    });
  });
});
