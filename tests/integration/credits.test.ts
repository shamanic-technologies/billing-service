import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { creditLedger, billingAccounts } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

describe("Credits deduction endpoint", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  const userId = "00000000-0000-0000-0000-000000000099";
  let stripeMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    stripeMocks = setupStripeMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
  });

  it("deducts credits successfully and writes ledger entry", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 200,
    });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({
        amount_cents: 5,
        description: "anthropic-sonnet-4.5 tokens",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      balance_cents: 195,
      depleted: false,
    });

    // Verify ledger entry was created
    const entries = await db
      .select()
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.orgId, orgId),
          eq(creditLedger.source, "deduct")
        )
      );
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("debit");
    expect(entries[0].amountCents).toBe(5);
    expect(entries[0].status).toBe("confirmed");
  });

  it("allows negative balance when insufficient", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 3,
    });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({
        amount_cents: 5,
        description: "test deduction",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.depleted).toBe(true);
    expect(res.body.balance_cents).toBe(-2);
  });

  it("does NOT auto-reload (reload removed from deduct)", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 3,
      reloadAmountCents: 2000,
      reloadThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({
        amount_cents: 5,
        description: "test deduction",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // No reload — just deducts into negative
    expect(res.body.balance_cents).toBe(-2);
    expect(res.body.depleted).toBe(true);
    expect(stripeMocks.chargePaymentMethod).not.toHaveBeenCalled();
  });

  it("auto-creates account for unknown org and deducts from trial balance", async () => {
    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders("00000000-0000-0000-0000-999999999999"))
      .send({
        amount_cents: 5,
        description: "test",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Auto-created with 200 cents ($2), then deducted 5
    expect(res.body.balance_cents).toBe(195);

    // Welcome ledger entry should exist
    const welcomeEntries = await db
      .select()
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.orgId, "00000000-0000-0000-0000-999999999999"),
          eq(creditLedger.source, "welcome")
        )
      );
    expect(welcomeEntries).toHaveLength(1);
    expect(welcomeEntries[0].amountCents).toBe(200);
  });

  it("validates request body", async () => {
    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({ amount_cents: -5 });

    expect(res.status).toBe(400);
  });

  it("fires Stripe balance transaction asynchronously", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 200,
    });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({
        amount_cents: 5,
        description: "test deduction",
      });

    expect(res.status).toBe(200);

    // Wait for async Stripe call
    await new Promise((r) => setTimeout(r, 50));

    expect(stripeMocks.createBalanceTransaction).toHaveBeenCalledWith(
      orgId,
      userId,
      "cus_123",
      5,
      "test deduction",
      undefined,
      {},
      expect.any(String) // idempotencyKey = ledger entry id
    );
  });

  it("handles multiple sequential deductions correctly", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 100,
    });

    const headers = getAuthHeaders(orgId);
    const body = {
      amount_cents: 10,
      description: "test",
    };

    const res1 = await request(app).post("/v1/credits/deduct").set(headers).send(body);
    expect(res1.body.balance_cents).toBe(90);

    const res2 = await request(app).post("/v1/credits/deduct").set(headers).send(body);
    expect(res2.body.balance_cents).toBe(80);

    const res3 = await request(app).post("/v1/credits/deduct").set(headers).send(body);
    expect(res3.body.balance_cents).toBe(70);
  });
});

describe("Credits authorize endpoint", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  const userId = "00000000-0000-0000-0000-000000000099";
  let stripeMocks: ReturnType<typeof setupStripeMocks>;

  const authorizeBody = {
    items: [
      { costName: "anthropic-sonnet-4-5-tokens-input", quantity: 1000 },
      { costName: "anthropic-sonnet-4-5-tokens-output", quantity: 500 },
    ],
    description: "content-generation — claude-sonnet-4-5",
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    stripeMocks = setupStripeMocks();
    await cleanTestData();

    // Mock costs-client to return deterministic prices
    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue(100);
  });

  afterAll(async () => {
    await cleanTestData();
  });

  it("returns sufficient: true when balance covers required amount", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 500,
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sufficient: true,
      balance_cents: 500,
      required_cents: 100,
    });
  });

  it("returns sufficient: false when balance is insufficient (no auto-reload)", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 50,
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sufficient: false,
      balance_cents: 50,
      required_cents: 100,
    });
  });

  it("auto-reloads and returns sufficient after reload", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 50,
      reloadAmountCents: 2000,
      reloadThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sufficient: true,
      balance_cents: 2050,
      required_cents: 100,
    });
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalledWith(
      orgId,
      userId,
      "cus_123",
      "pm_123",
      2000,
      "Auto-reload (1x)",
      {}
    );

    // Reload ledger entry should exist
    const reloadEntries = await db
      .select()
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.orgId, orgId),
          eq(creditLedger.source, "reload")
        )
      );
    expect(reloadEntries).toHaveLength(1);
    expect(reloadEntries[0].amountCents).toBe(2000);
    expect(reloadEntries[0].stripePaymentIntentId).toBe("pi_mock");
  });

  it("charges multiple reloads when required amount exceeds single reload", async () => {
    // Override costs-client to return a large required amount
    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue(3700);

    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 200,
      reloadAmountCents: 1000, // $10 reload unit
      reloadThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    // Need 3700, have 200 → deficit 3500 → ceil(3500/1000) = 4 → charge 4000
    expect(res.body).toEqual({
      sufficient: true,
      balance_cents: 4200, // 200 + 4000
      required_cents: 3700,
    });
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalledWith(
      orgId,
      userId,
      "cus_123",
      "pm_123",
      4000,
      "Auto-reload (4x)",
      {}
    );
  });

  it("returns sufficient: false when auto-reload fails and writes cancelled ledger entry", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 50,
      reloadAmountCents: 2000,
      reloadThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    stripeMocks.chargePaymentMethod.mockRejectedValue(
      new Error("Card declined")
    );

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sufficient: false,
      balance_cents: 50,
      required_cents: 100,
    });

    // Verify cancelled reload entry was written
    const reloadEntries = await db
      .select()
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.orgId, orgId),
          eq(creditLedger.source, "reload")
        )
      );
    expect(reloadEntries).toHaveLength(1);
    expect(reloadEntries[0].status).toBe("cancelled");
    expect(reloadEntries[0].type).toBe("credit");
  });

  it("skips auto-reload when a cancelled reload exists within 15 min cooldown", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 50,
      reloadAmountCents: 2000,
      reloadThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    // Insert a recent cancelled reload entry (5 min ago)
    await db.insert(creditLedger).values({
      orgId,
      userId,
      type: "credit",
      amountCents: 2000,
      status: "cancelled",
      source: "reload",
      description: "Auto-reload failed: Card declined",
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
    expect(stripeMocks.chargePaymentMethod).not.toHaveBeenCalled();
  });

  it("retries auto-reload when cancelled reload is older than 15 min", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 50,
      reloadAmountCents: 2000,
      reloadThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    // Back up the 50 cents with a confirmed ledger entry (so reconcile doesn't zero it)
    await db.insert(creditLedger).values({
      orgId,
      userId,
      type: "credit",
      amountCents: 50,
      status: "confirmed",
      source: "welcome",
      description: "Welcome credit",
    });

    // Insert an old cancelled reload entry (20 min ago)
    await db.insert(creditLedger).values({
      orgId,
      userId,
      type: "credit",
      amountCents: 2000,
      status: "cancelled",
      source: "reload",
      description: "Auto-reload failed: Card declined",
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);
    expect(res.body.balance_cents).toBe(2050);
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalled();
  });

  it("retries auto-reload when a confirmed reload is more recent than cancelled", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 50,
      reloadAmountCents: 2000,
      reloadThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    // Back up the 50 cents
    await db.insert(creditLedger).values({
      orgId,
      userId,
      type: "credit",
      amountCents: 50,
      status: "confirmed",
      source: "welcome",
      description: "Welcome credit",
    });

    // Insert a cancelled reload entry (3 min ago)
    await db.insert(creditLedger).values({
      orgId,
      userId,
      type: "credit",
      amountCents: 100,
      status: "cancelled",
      source: "reload",
      description: "Auto-reload failed: Card declined",
      createdAt: new Date(Date.now() - 3 * 60 * 1000),
    });

    // Insert a small confirmed reload entry (1 min ago) — resets cooldown
    await db.insert(creditLedger).values({
      orgId,
      userId,
      type: "credit",
      amountCents: 10,
      status: "confirmed",
      source: "reload",
      stripePaymentIntentId: "pi_previous",
      description: "Auto-reload credit",
      createdAt: new Date(Date.now() - 1 * 60 * 1000),
    });

    // Reconcile computes: 50 + 10 = 60 (cancelled ignored). 60 < 100 → reload
    // Last reload is confirmed → no cooldown → charges 2000
    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);
    expect(res.body.balance_cents).toBe(2060); // 60 + 2000
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalled();
  });

  it("auto-creates account for unknown org and authorizes from trial balance", async () => {
    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders("00000000-0000-0000-0000-999999999999"))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);
    // Auto-created with 200 cents ($2), costs-service mock returns 100
    expect(res.body.balance_cents).toBe(200);
  });

  it("validates request body — rejects empty items", async () => {
    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send({ items: [] });

    expect(res.status).toBe(400);
  });

  it("returns 400 when x-org-id is not a UUID", async () => {
    const res = await request(app)
      .post("/v1/credits/authorize")
      .set({
        "x-api-key": process.env.BILLING_SERVICE_API_KEY ?? "test-key",
        "x-org-id": "platform",
        "x-user-id": userId,
        "x-run-id": "00000000-0000-0000-0000-000000000001",
      })
      .send(authorizeBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id must be a valid UUID");
  });

  it("returns 502 when costs-service is unavailable", async () => {
    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockRejectedValue(
      new Error("COSTS_SERVICE not configured")
    );

    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 500,
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("costs-service");
  });

  it("reconciles cache drift (Check 1)", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 999, // deliberately wrong cache
    });

    // Insert a ledger entry that should compute to 300
    await db.insert(creditLedger).values({
      orgId,
      userId,
      type: "credit",
      amountCents: 300,
      status: "confirmed",
      source: "welcome",
      description: "Welcome credit",
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    // After reconcile, balance should be 300 (from ledger), not 999
    expect(res.body.balance_cents).toBe(300);
    expect(res.body.sufficient).toBe(true);
  });
});

describe("Credits authorize — reconcile race conditions", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-0000000000aa";
  const userId = "00000000-0000-0000-0000-000000000099";
  let stripeMocks: ReturnType<typeof setupStripeMocks>;

  const authorizeBody = {
    items: [{ costName: "anthropic-sonnet-4-5-tokens-input", quantity: 1000 }],
    description: "race-test",
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    stripeMocks = setupStripeMocks();
    await cleanTestData();

    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue(100);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("serializes reconcile across N concurrent /authorize calls (cache drift)", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_race",
      creditBalanceCents: 999, // wrong cache
    });
    await db.insert(creditLedger).values({
      orgId,
      userId,
      type: "credit",
      amountCents: 300,
      status: "confirmed",
      source: "welcome",
      description: "Welcome credit",
    });

    const N = 10;
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        request(app)
          .post("/v1/credits/authorize")
          .set(getAuthHeaders(orgId))
          .send(authorizeBody)
      )
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
    }
    // Only one welcome ledger row should exist — no duplicates from concurrent reconciles
    const entries = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.orgId, orgId));
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("welcome");
  });

  it("inserts a single reload ledger entry under N concurrent /authorize when a Stripe PI is missing from the ledger", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_race",
      creditBalanceCents: 500,
    });

    // Stripe says one succeeded PI exists; it has no matching ledger entry yet
    stripeMocks.listPaymentIntents.mockResolvedValue({
      data: [{ id: "pi_recover_xyz", status: "succeeded", amount: 2000 }],
      has_more: false,
    });

    const N = 10;
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        request(app)
          .post("/v1/credits/authorize")
          .set(getAuthHeaders(orgId))
          .send(authorizeBody)
      )
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    // Exactly one recovered reload entry — no duplicates from concurrent reconciles
    const reloadEntries = await db
      .select()
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.orgId, orgId),
          eq(creditLedger.source, "reload")
        )
      );
    expect(reloadEntries).toHaveLength(1);
    expect(reloadEntries[0].stripePaymentIntentId).toBe("pi_recover_xyz");
    expect(reloadEntries[0].amountCents).toBe(2000);
  });

  it("rejects duplicate (org_id, stripe_payment_intent_id) reload rows at the DB level", async () => {
    await db.insert(creditLedger).values({
      orgId,
      userId,
      type: "credit",
      amountCents: 1000,
      status: "confirmed",
      source: "reload",
      stripePaymentIntentId: "pi_dup_test",
      description: "first",
    });

    await expect(
      db.insert(creditLedger).values({
        orgId,
        userId,
        type: "credit",
        amountCents: 1000,
        status: "confirmed",
        source: "reload",
        stripePaymentIntentId: "pi_dup_test",
        description: "duplicate",
      })
    ).rejects.toThrow();
  });

  it("passes idempotencyKey = ledger entry id when syncing to Stripe (Check 3)", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_race",
      creditBalanceCents: 500,
    });

    const [entry] = await db
      .insert(creditLedger)
      .values({
        orgId,
        userId,
        type: "credit",
        amountCents: 500,
        status: "confirmed",
        source: "welcome",
        description: "Welcome credit",
        // stripeBalanceTxnId left null → Check 3 will sync this entry
      })
      .returning();

    stripeMocks.createBalanceTransaction.mockResolvedValue({
      id: "cbtxn_race",
      amount: -500,
      currency: "usd",
      description: "Welcome credit",
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(stripeMocks.createBalanceTransaction).toHaveBeenCalled();

    // 8th positional arg = idempotencyKey
    const calls = stripeMocks.createBalanceTransaction.mock.calls;
    const matched = calls.find((args) => args[7] === entry.id);
    expect(matched).toBeDefined();
  });
});
