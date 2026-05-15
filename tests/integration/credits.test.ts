import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { customerBalanceTransactions } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

describe("Customer balance authorize endpoint", () => {
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

    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue("100.0000000000");

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-05-13T00:00:00.000Z",
    });
  });

  afterAll(async () => {
    await cleanTestData();
  });

  it("returns sufficient: true when balance covers required amount", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      balanceCents: 500,
    });

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sufficient: true,
      balance_cents: "500.0000000000",
      required_cents: "100.0000000000",
    });
  });

  it("returns sufficient: false when balance is insufficient (no auto-topup)", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      balanceCents: 50,
    });

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sufficient: false,
      balance_cents: "50.0000000000",
      required_cents: "100.0000000000",
    });
  });

  it("auto-topups and returns sufficient after topup", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      balanceCents: 50,
      topupAmountCents: 2000,
      topupThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sufficient: true,
      balance_cents: "2050.0000000000",
      required_cents: "100.0000000000",
    });
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalledWith(
      orgId,
      userId,
      "cus_123",
      "pm_123",
      2000,
      "Auto-topup (1x)",
      {}
    );

    // Payment ledger entry should exist with signed negative amount
    const paymentEntries = await db
      .select()
      .from(customerBalanceTransactions)
      .where(
        and(
          eq(customerBalanceTransactions.orgId, orgId),
          eq(customerBalanceTransactions.type, "payment")
        )
      );
    expect(paymentEntries).toHaveLength(1);
    expect(paymentEntries[0].amountCents).toBe("-2000.0000000000");
    expect(paymentEntries[0].stripePaymentIntentId).toBe("pi_mock");
    expect(paymentEntries[0].status).toBe("succeeded");
  });

  it("charges multiple topup units when required amount exceeds single topup", async () => {
    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue("3700.0000000000");

    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      balanceCents: 200,
      topupAmountCents: 1000, // $10 topup unit
      topupThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    // Need 3700, have 200 → deficit 3500 → ceil(3500/1000) = 4 → charge 4000
    expect(res.body).toEqual({
      sufficient: true,
      balance_cents: "4200.0000000000", // 200 + 4000
      required_cents: "3700.0000000000",
    });
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalledWith(
      orgId,
      userId,
      "cus_123",
      "pm_123",
      4000,
      "Auto-topup (4x)",
      {}
    );
  });

  it("returns sufficient: false when auto-topup fails and writes canceled ledger entry", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      balanceCents: 50,
      topupAmountCents: 2000,
      topupThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    stripeMocks.chargePaymentMethod.mockRejectedValue(
      new Error("Card declined")
    );

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sufficient: false,
      balance_cents: "50.0000000000",
      required_cents: "100.0000000000",
    });

    const paymentEntries = await db
      .select()
      .from(customerBalanceTransactions)
      .where(
        and(
          eq(customerBalanceTransactions.orgId, orgId),
          eq(customerBalanceTransactions.type, "payment")
        )
      );
    expect(paymentEntries).toHaveLength(1);
    expect(paymentEntries[0].status).toBe("canceled");
    expect(paymentEntries[0].type).toBe("payment");
  });

  it("skips auto-topup when a canceled payment exists within 15 min cooldown", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      balanceCents: 50,
      topupAmountCents: 2000,
      topupThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    // Insert a recent canceled payment entry (5 min ago)
    await db.insert(customerBalanceTransactions).values({
      orgId,
      userId,
      type: "payment",
      amountCents: "-2000.0000000000",
      status: "canceled",
      description: "Auto-topup failed: Card declined",
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
    expect(stripeMocks.chargePaymentMethod).not.toHaveBeenCalled();
  });

  it("retries auto-topup when canceled payment is older than 15 min", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      balanceCents: 50,
      topupAmountCents: 2000,
      topupThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    // Insert an old canceled payment (20 min ago)
    await db.insert(customerBalanceTransactions).values({
      orgId,
      userId,
      type: "payment",
      amountCents: "-2000.0000000000",
      status: "canceled",
      description: "Auto-topup failed: Card declined",
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);
    expect(res.body.balance_cents).toBe("2050.0000000000");
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalled();
  });

  it("retries auto-topup when a succeeded payment is more recent than canceled", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      balanceCents: 60,
      topupAmountCents: 2000,
      topupThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    // Insert a canceled payment entry (3 min ago)
    await db.insert(customerBalanceTransactions).values({
      orgId,
      userId,
      type: "payment",
      amountCents: "-100.0000000000",
      status: "canceled",
      description: "Auto-topup failed: Card declined",
      createdAt: new Date(Date.now() - 3 * 60 * 1000),
    });

    // Insert a small succeeded payment entry (1 min ago) — resets cooldown
    await db.insert(customerBalanceTransactions).values({
      orgId,
      userId,
      type: "payment",
      amountCents: "-10.0000000000",
      status: "succeeded",
      stripePaymentIntentId: "pi_previous",
      description: "Auto-topup",
      createdAt: new Date(Date.now() - 1 * 60 * 1000),
    });

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);
    expect(res.body.balance_cents).toBe("2060.0000000000"); // 60 + 2000
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalled();
  });

  it("auto-creates account for unknown org and authorizes from trial balance", async () => {
    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders("00000000-0000-0000-0000-999999999999"))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);
    expect(res.body.balance_cents).toBe("200.0000000000");
  });

  it("validates request body — rejects empty items", async () => {
    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId))
      .send({ items: [] });

    expect(res.status).toBe(400);
  });

  it("returns 400 when x-org-id is not a UUID", async () => {
    const res = await request(app)
      .post("/v1/customer_balance/authorize")
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
      balanceCents: 500,
    });

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("costs-service");
  });

  it("uses billing balance minus runs-service usage, not ledger reconciliation", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      balanceCents: 999,
    });

    // Historical ledger rows are not reconciled during authorize anymore.
    await db.insert(customerBalanceTransactions).values({
      orgId,
      userId,
      type: "gift",
      amountCents: "-300.0000000000",
      status: "succeeded",
      description: "Welcome gift",
    });

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.balance_cents).toBe("999.0000000000");
    expect(res.body.sufficient).toBe(true);
  });
});

describe("Customer balance authorize — topup concurrency", () => {
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
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue("100.0000000000");

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-05-13T00:00:00.000Z",
    });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("does not reconcile ledger rows during concurrent /authorize calls", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_race",
      balanceCents: 999,
    });
    await db.insert(customerBalanceTransactions).values({
      orgId,
      userId,
      type: "gift",
      amountCents: "-300.0000000000",
      status: "succeeded",
      description: "Welcome gift",
    });

    const N = 10;
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        request(app)
          .post("/v1/customer_balance/authorize")
          .set(getAuthHeaders(orgId))
          .send(authorizeBody)
      )
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
    }
    // Only the pre-existing gift row should exist.
    const entries = await db
      .select()
      .from(customerBalanceTransactions)
      .where(eq(customerBalanceTransactions.orgId, orgId));
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("gift");
  });

  it("inserts a single topup row under N concurrent insufficient /authorize calls", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_race",
      stripePaymentMethodId: "pm_race",
      balanceCents: 50,
      topupAmountCents: 2000,
      topupThresholdCents: 200,
    });

    const N = 10;
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        request(app)
          .post("/v1/customer_balance/authorize")
          .set(getAuthHeaders(orgId))
          .send(authorizeBody)
      )
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    const paymentEntries = await db
      .select()
      .from(customerBalanceTransactions)
      .where(
        and(
          eq(customerBalanceTransactions.orgId, orgId),
          eq(customerBalanceTransactions.type, "payment")
        )
      );
    expect(paymentEntries).toHaveLength(1);
    expect(paymentEntries[0].amountCents).toBe("-2000.0000000000");
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate (org_id, stripe_payment_intent_id) payment rows at the DB level", async () => {
    await db.insert(customerBalanceTransactions).values({
      orgId,
      userId,
      type: "payment",
      amountCents: "-1000.0000000000",
      status: "succeeded",
      stripePaymentIntentId: "pi_dup_test",
      description: "first",
    });

    await expect(
      db.insert(customerBalanceTransactions).values({
        orgId,
        userId,
        type: "payment",
        amountCents: "-1000.0000000000",
        status: "succeeded",
        stripePaymentIntentId: "pi_dup_test",
        description: "duplicate",
      })
    ).rejects.toThrow();
  });
});

describe("Removed v1 routes", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-00000000a001";

  it("returns 404 for legacy POST /v1/credits/authorize", async () => {
    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send({ items: [{ costName: "x", quantity: 1 }] });
    expect(res.status).toBe(404);
  });

  it("returns 404 for legacy POST /v1/credits/usage-notify", async () => {
    const res = await request(app)
      .post("/v1/credits/usage-notify")
      .set(getAuthHeaders(orgId))
      .send({ spent_total_cents: "0" });
    expect(res.status).toBe(404);
  });
});
