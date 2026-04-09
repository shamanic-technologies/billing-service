import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { creditProvisions, billingAccounts } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

describe("Credit provision endpoints", () => {
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

  describe("POST /v1/credits/provision", () => {
    it("provisions credits and deducts from balance", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_123",
        creditBalanceCents: 500,
      });

      const res = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "estimated cost" });

      expect(res.status).toBe(200);
      expect(res.body.provision_id).toBeDefined();
      expect(res.body.balance_cents).toBe(400);
      expect(res.body.depleted).toBe(false);
    });

    it("allows negative balance on provision", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_123",
        creditBalanceCents: 50,
      });

      const res = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 200, description: "large task" });

      expect(res.status).toBe(200);
      expect(res.body.balance_cents).toBe(-150);
      expect(res.body.depleted).toBe(true);
    });

    it("auto-creates account for unknown org and provisions from trial balance", async () => {
      const res = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders("00000000-0000-0000-0000-999999999999"))
        .send({ amount_cents: 100, description: "test" });

      expect(res.status).toBe(200);
      expect(res.body.provision_id).toBeDefined();
      // Auto-created with 200 cents ($2), then provisioned 100
      expect(res.body.balance_cents).toBe(100);
    });

    it("stores workflow headers in provision record", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_123",
        creditBalanceCents: 500,
      });

      const res = await request(app)
        .post("/v1/credits/provision")
        .set({
          ...getAuthHeaders(orgId),
          "x-campaign-id": "camp_42",
          "x-brand-id": "brand_7",
          "x-workflow-slug": "outreach-flow",
          "x-feature-slug": "press-outreach",
        })
        .send({ amount_cents: 50, description: "tracked provision" });

      expect(res.status).toBe(200);
      expect(res.body.provision_id).toBeDefined();

      // Verify all workflow headers including feature_slug are persisted
      const [row] = await db
        .select()
        .from(creditProvisions)
        .where(eq(creditProvisions.id, res.body.provision_id))
        .limit(1);

      expect(row.campaignId).toBe("camp_42");
      expect(row.brandIds).toEqual(["brand_7"]);
      expect(row.workflowSlug).toBe("outreach-flow");
      expect(row.featureSlug).toBe("press-outreach");
    });

    it("stores multiple brand IDs from CSV x-brand-id header", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_123",
        creditBalanceCents: 500,
      });

      const res = await request(app)
        .post("/v1/credits/provision")
        .set({
          ...getAuthHeaders(orgId),
          "x-brand-id": "brand_1, brand_2, brand_3",
        })
        .send({ amount_cents: 50, description: "multi-brand provision" });

      expect(res.status).toBe(200);
      expect(res.body.provision_id).toBeDefined();

      const [row] = await db
        .select()
        .from(creditProvisions)
        .where(eq(creditProvisions.id, res.body.provision_id))
        .limit(1);

      expect(row.brandIds).toEqual(["brand_1", "brand_2", "brand_3"]);
    });

    it("validates request body", async () => {
      const res = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: -5 });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /v1/credits/provision/:id/confirm", () => {
    it("confirms a pending provision with no adjustment", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_123",
        creditBalanceCents: 500,
      });

      const provRes = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "test" });

      const provisionId = provRes.body.provision_id;

      const res = await request(app)
        .post(`/v1/credits/provision/${provisionId}/confirm`)
        .set(getAuthHeaders(orgId))
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("confirmed");
      expect(res.body.original_amount_cents).toBe(100);
      expect(res.body.final_amount_cents).toBe(100);
      expect(res.body.adjustment_cents).toBe(0);
      expect(res.body.balance_cents).toBe(400);
    });

    it("adjusts balance when actual cost is lower", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_123",
        creditBalanceCents: 500,
      });

      const provRes = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "test" });

      // Balance is now 400. Confirm with actual 60 → credit back 40 → balance 440
      const res = await request(app)
        .post(`/v1/credits/provision/${provRes.body.provision_id}/confirm`)
        .set(getAuthHeaders(orgId))
        .send({ actual_amount_cents: 60 });

      expect(res.status).toBe(200);
      expect(res.body.adjustment_cents).toBe(40);
      expect(res.body.final_amount_cents).toBe(60);
      expect(res.body.balance_cents).toBe(440);
    });

    it("adjusts balance when actual cost is higher", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_123",
        creditBalanceCents: 500,
      });

      const provRes = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "test" });

      // Balance is now 400. Confirm with actual 150 → deduct 50 more → balance 350
      const res = await request(app)
        .post(`/v1/credits/provision/${provRes.body.provision_id}/confirm`)
        .set(getAuthHeaders(orgId))
        .send({ actual_amount_cents: 150 });

      expect(res.status).toBe(200);
      expect(res.body.adjustment_cents).toBe(-50);
      expect(res.body.final_amount_cents).toBe(150);
      expect(res.body.balance_cents).toBe(350);
    });

    it("returns 409 for already confirmed provision", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_123",
        creditBalanceCents: 500,
      });

      const provRes = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "test" });

      const provisionId = provRes.body.provision_id;

      await request(app)
        .post(`/v1/credits/provision/${provisionId}/confirm`)
        .set(getAuthHeaders(orgId))
        .send({});

      const res = await request(app)
        .post(`/v1/credits/provision/${provisionId}/confirm`)
        .set(getAuthHeaders(orgId))
        .send({});

      expect(res.status).toBe(409);
    });

    it("returns 404 for unknown provision", async () => {
      await insertTestAccount({ orgId });

      const res = await request(app)
        .post("/v1/credits/provision/00000000-0000-0000-0000-000000000999/confirm")
        .set(getAuthHeaders(orgId))
        .send({});

      expect(res.status).toBe(404);
    });
  });

  describe("POST /v1/credits/provision/:id/cancel", () => {
    it("cancels a pending provision and re-credits balance", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_123",
        creditBalanceCents: 500,
      });

      const provRes = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "test" });

      // Balance is now 400. Cancel → re-credit 100 → balance 500
      const res = await request(app)
        .post(`/v1/credits/provision/${provRes.body.provision_id}/cancel`)
        .set(getAuthHeaders(orgId))
        .send();

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("cancelled");
      expect(res.body.refunded_cents).toBe(100);
      expect(res.body.balance_cents).toBe(500);
    });

    it("returns 409 for already cancelled provision", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_123",
        creditBalanceCents: 500,
      });

      const provRes = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "test" });

      const provisionId = provRes.body.provision_id;

      await request(app)
        .post(`/v1/credits/provision/${provisionId}/cancel`)
        .set(getAuthHeaders(orgId))
        .send();

      const res = await request(app)
        .post(`/v1/credits/provision/${provisionId}/cancel`)
        .set(getAuthHeaders(orgId))
        .send();

      expect(res.status).toBe(409);
    });

    it("cannot cancel a confirmed provision", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_123",
        creditBalanceCents: 500,
      });

      const provRes = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "test" });

      await request(app)
        .post(`/v1/credits/provision/${provRes.body.provision_id}/confirm`)
        .set(getAuthHeaders(orgId))
        .send({});

      const res = await request(app)
        .post(`/v1/credits/provision/${provRes.body.provision_id}/cancel`)
        .set(getAuthHeaders(orgId))
        .send();

      expect(res.status).toBe(409);
    });
  });

  describe("Auto-reload credit provisions", () => {
    it("creates a credit provision when balance drops below threshold", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_123",
        creditBalanceCents: 250,
        reloadAmountCents: 1000,
        reloadThresholdCents: 200,
        stripePaymentMethodId: "pm_123",
      });

      const res = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "test" });

      expect(res.status).toBe(200);
      // Balance: 250 - 100 = 150 (< 200 threshold) → credit provision for 1000
      // Returned balance includes the credit provision: 150 + 1000 = 1150
      expect(res.body.balance_cents).toBe(1150);

      // Wait for async confirmation to complete
      await new Promise((r) => setTimeout(r, 50));

      // Verify a credit provision was created in DB
      const creditProvs = await db
        .select()
        .from(creditProvisions)
        .where(
          and(
            eq(creditProvisions.orgId, orgId),
            eq(creditProvisions.type, "credit")
          )
        );

      expect(creditProvs).toHaveLength(1);
      expect(creditProvs[0].amountCents).toBe(1000);
      // Async handler confirms it after Stripe charge succeeds
      expect(creditProvs[0].status).toBe("confirmed");
      expect(creditProvs[0].stripePaymentIntentId).toBe("pi_mock");
    });

    it("does not create a credit provision when balance stays above threshold", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_123",
        creditBalanceCents: 500,
        reloadAmountCents: 1000,
        reloadThresholdCents: 200,
        stripePaymentMethodId: "pm_123",
      });

      const res = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "test" });

      expect(res.status).toBe(200);
      expect(res.body.balance_cents).toBe(400);

      const creditProvs = await db
        .select()
        .from(creditProvisions)
        .where(
          and(
            eq(creditProvisions.orgId, orgId),
            eq(creditProvisions.type, "credit")
          )
        );

      expect(creditProvs).toHaveLength(0);
    });

    it("two sequential provisions only create one credit provision (no double reload)", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_123",
        creditBalanceCents: 210,
        reloadAmountCents: 1000,
        reloadThresholdCents: 200,
        stripePaymentMethodId: "pm_123",
      });

      // First provision: 210 - 50 = 160 → below threshold → credit provision created
      const res1 = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 50, description: "first" });

      expect(res1.status).toBe(200);
      expect(res1.body.balance_cents).toBe(1160); // 160 + 1000

      // Second provision: 1160 - 50 = 1110 → above threshold → no credit provision
      const res2 = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 50, description: "second" });

      expect(res2.status).toBe(200);
      expect(res2.body.balance_cents).toBe(1110);

      // Only 1 credit provision should exist
      const creditProvs = await db
        .select()
        .from(creditProvisions)
        .where(
          and(
            eq(creditProvisions.orgId, orgId),
            eq(creditProvisions.type, "credit")
          )
        );

      expect(creditProvs).toHaveLength(1);
    });

    it("reverses credit provision when Stripe charge fails", async () => {
      stripeMocks.chargePaymentMethod.mockRejectedValue(
        new Error("Card declined")
      );

      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_123",
        creditBalanceCents: 250,
        reloadAmountCents: 1000,
        reloadThresholdCents: 200,
        stripePaymentMethodId: "pm_123",
      });

      const res = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "test" });

      expect(res.status).toBe(200);
      // Response shows optimistic balance (150 + 1000)
      expect(res.body.balance_cents).toBe(1150);

      // Wait for async rollback to complete
      await new Promise((r) => setTimeout(r, 100));

      // After async rollback, balance should be back to 150 (no credit)
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId))
        .limit(1);

      expect(account.creditBalanceCents).toBe(150);

      // Credit provision should be cancelled
      const creditProvs = await db
        .select()
        .from(creditProvisions)
        .where(
          and(
            eq(creditProvisions.orgId, orgId),
            eq(creditProvisions.type, "credit")
          )
        );

      expect(creditProvs).toHaveLength(1);
      expect(creditProvs[0].status).toBe("cancelled");
    });
  });
});
