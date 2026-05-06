import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { transactions, billingAccounts } from "../../src/db/schema.js";
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

      const entries = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, res.body.provision_id));
      expect(entries).toHaveLength(1);
      expect(entries[0].source).toBe("charge");
      expect(entries[0].type).toBe("debit");
      expect(entries[0].status).toBe("pending");
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

      const [row] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, res.body.provision_id))
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

      const [row] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, res.body.provision_id))
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

    it("fires Stripe balance txn for the provision debit", async () => {
      await insertTestAccount({
        orgId,
        stripeCustomerId: "cus_123",
        creditBalanceCents: 500,
      });

      const res = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "test provision" });

      expect(res.status).toBe(200);

      // Wait for fire-and-forget
      await new Promise((r) => setTimeout(r, 50));

      expect(stripeMocks.createBalanceTransaction).toHaveBeenCalledWith(
        orgId,
        expect.any(String),
        "cus_123",
        100,
        "test provision",
        undefined,
        {}
      );
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

    it("on lower actual cost: cancels original hold, writes new charge at $Y, refunds delta", async () => {
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
        .send({ actual_amount_cents: 60 });

      expect(res.status).toBe(200);
      expect(res.body.adjustment_cents).toBe(40);
      expect(res.body.final_amount_cents).toBe(60);
      expect(res.body.balance_cents).toBe(440);

      // Original row mutates to cancelled at $X, no miroir credit row.
      const original = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, provisionId));
      expect(original).toHaveLength(1);
      expect(original[0].status).toBe("cancelled");
      expect(original[0].amountCents).toBe(100);
      expect(original[0].source).toBe("charge");

      // Exactly one fresh confirmed charge row at $Y.
      const confirmed = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.orgId, orgId),
            eq(transactions.source, "charge"),
            eq(transactions.status, "confirmed")
          )
        );
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0].type).toBe("debit");
      expect(confirmed[0].amountCents).toBe(60);

      // No legacy miroir sources written
      const legacy = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.orgId, orgId),
            eq(transactions.source, "provision_adjust")
          )
        );
      expect(legacy).toHaveLength(0);
    });

    it("on higher actual cost: cancels original hold, writes new charge at $Y, deducts delta", async () => {
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
        .send({ actual_amount_cents: 150 });

      expect(res.status).toBe(200);
      expect(res.body.adjustment_cents).toBe(-50);
      expect(res.body.final_amount_cents).toBe(150);
      expect(res.body.balance_cents).toBe(350);

      const original = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, provisionId));
      expect(original[0].status).toBe("cancelled");
      expect(original[0].amountCents).toBe(100);

      const confirmed = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.orgId, orgId),
            eq(transactions.source, "charge"),
            eq(transactions.status, "confirmed")
          )
        );
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0].amountCents).toBe(150);
    });

    it("on same amount: mutates row pending→confirmed, no new row", async () => {
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
        .send({ actual_amount_cents: 100 });

      expect(res.status).toBe(200);
      expect(res.body.balance_cents).toBe(400);

      const all = await db
        .select()
        .from(transactions)
        .where(eq(transactions.orgId, orgId));
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(provisionId);
      expect(all[0].status).toBe("confirmed");
      expect(all[0].amountCents).toBe(100);
    });

    it("returns 200 idempotently for already confirmed provision", async () => {
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

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("confirmed");
      expect(res.body.provision_id).toBe(provisionId);
      expect(res.body.adjustment_cents).toBe(0);
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
    it("cancels a pending provision, re-credits balance, mutates row, no miroir credit", async () => {
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
        .post(`/v1/credits/provision/${provisionId}/cancel`)
        .set(getAuthHeaders(orgId))
        .send();

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("cancelled");
      expect(res.body.refunded_cents).toBe(100);
      expect(res.body.balance_cents).toBe(500);

      // Original row mutates to cancelled — no new miroir credit row.
      const all = await db
        .select()
        .from(transactions)
        .where(eq(transactions.orgId, orgId));
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(provisionId);
      expect(all[0].status).toBe("cancelled");
      expect(all[0].type).toBe("debit");

      const legacy = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.orgId, orgId),
            eq(transactions.source, "provision_cancel")
          )
        );
      expect(legacy).toHaveLength(0);
    });

    it("returns 200 idempotently for already cancelled provision", async () => {
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

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("cancelled");
      expect(res.body.provision_id).toBe(provisionId);
      expect(res.body.refunded_cents).toBe(0);
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

  describe("No auto-reload on provision (reload only in authorize)", () => {
    it("does not auto-reload even when balance drops below threshold", async () => {
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
      expect(res.body.balance_cents).toBe(150);
      expect(stripeMocks.chargePaymentMethod).not.toHaveBeenCalled();

      const creditEntries = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.orgId, orgId),
            eq(transactions.type, "credit"),
            eq(transactions.source, "reload")
          )
        );

      expect(creditEntries).toHaveLength(0);
    });
  });
});
