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
      expect(res.body.balance_cents).toBe("400.0000000000");
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
      expect(res.body.balance_cents).toBe("-150.0000000000");
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
      expect(res.body.balance_cents).toBe("100.0000000000");
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
      expect(res.body.original_amount_cents).toBe("100.0000000000");
      expect(res.body.final_amount_cents).toBe("100.0000000000");
      expect(res.body.adjustment_cents).toBe("0.0000000000");
      expect(res.body.balance_cents).toBe("400.0000000000");
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
      expect(res.body.adjustment_cents).toBe("40.0000000000");
      expect(res.body.final_amount_cents).toBe("60.0000000000");
      expect(res.body.balance_cents).toBe("440.0000000000");

      // Original row mutates to cancelled at $X, no miroir credit row.
      const original = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, provisionId));
      expect(original).toHaveLength(1);
      expect(original[0].status).toBe("cancelled");
      expect(original[0].amountCents).toBe("100.0000000000");
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
      expect(confirmed[0].amountCents).toBe("60.0000000000");

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
      expect(res.body.adjustment_cents).toBe("-50.0000000000");
      expect(res.body.final_amount_cents).toBe("150.0000000000");
      expect(res.body.balance_cents).toBe("350.0000000000");

      const original = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, provisionId));
      expect(original[0].status).toBe("cancelled");
      expect(original[0].amountCents).toBe("100.0000000000");

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
      expect(confirmed[0].amountCents).toBe("150.0000000000");
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
      expect(res.body.balance_cents).toBe("400.0000000000");

      const all = await db
        .select()
        .from(transactions)
        .where(eq(transactions.orgId, orgId));
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(provisionId);
      expect(all[0].status).toBe("confirmed");
      expect(all[0].amountCents).toBe("100.0000000000");
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
      expect(res.body.adjustment_cents).toBe("0.0000000000");
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
      expect(res.body.refunded_cents).toBe("100.0000000000");
      expect(res.body.balance_cents).toBe("500.0000000000");

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
      expect(res.body.refunded_cents).toBe("0.0000000000");
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

  describe("cost_id natural key — by-cost/:cost_id endpoints", () => {
    const costIdA = "cccc0000-0000-0000-0000-00000000000a";
    const costIdB = "cccc0000-0000-0000-0000-00000000000b";
    const unknownCostId = "cccc0000-0000-0000-0000-0000ffffffff";

    it("persists cost_id on provision row when provided", async () => {
      await insertTestAccount({ orgId, creditBalanceCents: 500 });

      const res = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "with cost_id", cost_id: costIdA });

      expect(res.status).toBe(200);
      expect(res.body.cost_id).toBe(costIdA);

      const [row] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, res.body.provision_id));
      expect(row.costId).toBe(costIdA);
    });

    it("confirm by-cost/:cost_id flips status; second call same amount is idempotent", async () => {
      await insertTestAccount({ orgId, creditBalanceCents: 500 });

      const provRes = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "by-cost flow", cost_id: costIdA });
      expect(provRes.status).toBe(200);

      const first = await request(app)
        .post(`/v1/credits/provision/by-cost/${costIdA}/confirm`)
        .set(getAuthHeaders(orgId))
        .send({});
      expect(first.status).toBe(200);
      expect(first.body.status).toBe("confirmed");
      expect(first.body.cost_id).toBe(costIdA);
      expect(first.body.provision_id).toBe(provRes.body.provision_id);

      const second = await request(app)
        .post(`/v1/credits/provision/by-cost/${costIdA}/confirm`)
        .set(getAuthHeaders(orgId))
        .send({});
      expect(second.status).toBe(200);
      expect(second.body.status).toBe("confirmed");
      expect(second.body.adjustment_cents).toBe("0.0000000000");

      const all = await db
        .select()
        .from(transactions)
        .where(eq(transactions.orgId, orgId));
      expect(all).toHaveLength(1);
      expect(all[0].status).toBe("confirmed");
    });

    it("returns 409 with structured body when re-confirming at a different amount", async () => {
      await insertTestAccount({ orgId, creditBalanceCents: 500 });

      await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "x", cost_id: costIdA });

      const first = await request(app)
        .post(`/v1/credits/provision/by-cost/${costIdA}/confirm`)
        .set(getAuthHeaders(orgId))
        .send({ actual_amount_cents: 100 });
      expect(first.status).toBe(200);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const second = await request(app)
        .post(`/v1/credits/provision/by-cost/${costIdA}/confirm`)
        .set(getAuthHeaders(orgId))
        .send({ actual_amount_cents: 150 });

      expect(second.status).toBe(409);
      expect(second.body.cost_id).toBe(costIdA);
      expect(second.body.current_status).toBe("confirmed");
      expect(second.body.current_amount_cents).toBe("100.0000000000");
      expect(second.body.requested_amount_cents).toBe("150.0000000000");
      expect(warnSpy).toHaveBeenCalledWith(
        "[billing-service] provision confirm rejected",
        expect.objectContaining({
          cost_id: costIdA,
          current_status: "confirmed",
          current_amount_cents: "100.0000000000",
          requested_amount_cents: "150.0000000000",
        })
      );
      warnSpy.mockRestore();
    });

    it("returns 409 when confirming a cancelled cost_id", async () => {
      await insertTestAccount({ orgId, creditBalanceCents: 500 });

      await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "x", cost_id: costIdA });

      const cancelRes = await request(app)
        .post(`/v1/credits/provision/by-cost/${costIdA}/cancel`)
        .set(getAuthHeaders(orgId))
        .send();
      expect(cancelRes.status).toBe(200);

      const confirmRes = await request(app)
        .post(`/v1/credits/provision/by-cost/${costIdA}/confirm`)
        .set(getAuthHeaders(orgId))
        .send({});
      expect(confirmRes.status).toBe(409);
      expect(confirmRes.body.cost_id).toBe(costIdA);
      expect(confirmRes.body.current_status).toBe("cancelled");
    });

    it("re-cancel of cancelled cost_id is idempotent (200)", async () => {
      await insertTestAccount({ orgId, creditBalanceCents: 500 });

      await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "x", cost_id: costIdA });

      const first = await request(app)
        .post(`/v1/credits/provision/by-cost/${costIdA}/cancel`)
        .set(getAuthHeaders(orgId))
        .send();
      expect(first.status).toBe(200);
      expect(first.body.refunded_cents).toBe("100.0000000000");

      const second = await request(app)
        .post(`/v1/credits/provision/by-cost/${costIdA}/cancel`)
        .set(getAuthHeaders(orgId))
        .send();
      expect(second.status).toBe(200);
      expect(second.body.refunded_cents).toBe("0.0000000000");
      expect(second.body.cost_id).toBe(costIdA);
    });

    it("returns 404 with cost_id in body for unknown cost_id", async () => {
      await insertTestAccount({ orgId });

      const res = await request(app)
        .post(`/v1/credits/provision/by-cost/${unknownCostId}/confirm`)
        .set(getAuthHeaders(orgId))
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.cost_id).toBe(unknownCostId);
      expect(res.body.provision_id).toBe(null);
      expect(res.body.current_status).toBe(null);
    });

    it("amount-mismatch confirm carries cost_id onto replacement row; subsequent by-cost lookup hits the latest row", async () => {
      await insertTestAccount({ orgId, creditBalanceCents: 500 });

      const provRes = await request(app)
        .post("/v1/credits/provision")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: 100, description: "x", cost_id: costIdB });

      const confirmRes = await request(app)
        .post(`/v1/credits/provision/by-cost/${costIdB}/confirm`)
        .set(getAuthHeaders(orgId))
        .send({ actual_amount_cents: 60 });
      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body.adjustment_cents).toBe("40.0000000000");
      expect(confirmRes.body.cost_id).toBe(costIdB);

      // Replacement row carries cost_id; subsequent same-amount confirm idempotently finds it.
      const reConfirm = await request(app)
        .post(`/v1/credits/provision/by-cost/${costIdB}/confirm`)
        .set(getAuthHeaders(orgId))
        .send({ actual_amount_cents: 60 });
      expect(reConfirm.status).toBe(200);
      expect(reConfirm.body.provision_id).toBe(confirmRes.body.provision_id);
      expect(reConfirm.body.provision_id).not.toBe(provRes.body.provision_id);

      const rows = await db
        .select()
        .from(transactions)
        .where(eq(transactions.costId, costIdB));
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.status === "cancelled")?.amountCents).toBe("100.0000000000");
      expect(rows.find((r) => r.status === "confirmed")?.amountCents).toBe("60.0000000000");
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
      expect(res.body.balance_cents).toBe("150.0000000000");
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
