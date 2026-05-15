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

describe("Promotion code endpoints", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  const orgId2 = "00000000-0000-0000-0000-000000000002";
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

  describe("POST /v1/promotion_codes/redeem", () => {
    it("redeems a valid promo code and surfaces total local credits", async () => {
      await insertTestAccount({ orgId });
      await insertTestPromoCode({ code: "qr10", amountCents: 800 });

      const res = await request(app)
        .post("/v1/promotion_codes/redeem")
        .set(getAuthHeaders(orgId))
        .send({ code: "qr10" });

      expect(res.status).toBe(200);
      expect(res.body.redeemed).toBe(true);
      // Positive grant amount.
      expect(res.body.amount_cents).toBe("800");
      // No welcome on this account (inserted manually) → only the promo.
      expect(res.body.local_credits_total_cents).toBe("800.0000000000");
      expect(ssMocks.getCustomerByOrg).not.toHaveBeenCalled();
      expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
    });

    it("auto-creates billing account with welcome + applies promo on top", async () => {
      await insertTestPromoCode({ code: "welcome10", amountCents: 1000 });

      const res = await request(app)
        .post("/v1/promotion_codes/redeem")
        .set(getAuthHeaders(orgId))
        .send({ code: "welcome10" });

      expect(res.status).toBe(200);
      expect(res.body.redeemed).toBe(true);
      // welcome 200 + promo 1000 = 1200.
      expect(res.body.local_credits_total_cents).toBe("1200.0000000000");
    });

    it("returns 400 for invalid promo code", async () => {
      await insertTestAccount({ orgId });

      const res = await request(app)
        .post("/v1/promotion_codes/redeem")
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
        .post("/v1/promotion_codes/redeem")
        .set(getAuthHeaders(orgId))
        .send({ code: "expired" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Promo code has expired");
    });

    it("returns 400 when max redemptions reached", async () => {
      await insertTestAccount({ orgId });
      await insertTestAccount({ orgId: orgId2 });
      await insertTestPromoCode({
        code: "limited",
        amountCents: 500,
        maxRedemptions: 1,
      });

      await request(app)
        .post("/v1/promotion_codes/redeem")
        .set(getAuthHeaders(orgId2))
        .send({ code: "limited" });

      const res = await request(app)
        .post("/v1/promotion_codes/redeem")
        .set(getAuthHeaders(orgId))
        .send({ code: "limited" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Promo code has reached its redemption limit");
    });

    it("returns 409 when org already redeemed the code", async () => {
      await insertTestAccount({ orgId });
      await insertTestPromoCode({ code: "qr10", amountCents: 800 });

      await request(app)
        .post("/v1/promotion_codes/redeem")
        .set(getAuthHeaders(orgId))
        .send({ code: "qr10" });

      const res = await request(app)
        .post("/v1/promotion_codes/redeem")
        .set(getAuthHeaders(orgId))
        .send({ code: "qr10" });

      expect(res.status).toBe(409);
    });

    it("returns 400 when code is missing", async () => {
      const res = await request(app)
        .post("/v1/promotion_codes/redeem")
        .set(getAuthHeaders(orgId))
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 401 without API key", async () => {
      const res = await request(app)
        .post("/v1/promotion_codes/redeem")
        .set({ "x-org-id": orgId })
        .send({ code: "qr10" });

      expect(res.status).toBe(401);
    });
  });
});
