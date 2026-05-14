import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { transactions } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

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
      creditBalanceCents: 500,
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sufficient: true,
      balance_cents: "500.0000000000",
      required_cents: "100.0000000000",
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
      balance_cents: "50.0000000000",
      required_cents: "100.0000000000",
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
      balance_cents: "2050.0000000000",
      required_cents: "100.0000000000",
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
      .from(transactions)
      .where(
        and(
          eq(transactions.orgId, orgId),
          eq(transactions.source, "reload")
        )
      );
    expect(reloadEntries).toHaveLength(1);
    expect(reloadEntries[0].amountCents).toBe("2000.0000000000");
    expect(reloadEntries[0].stripePaymentIntentId).toBe("pi_mock");
  });

  it("charges multiple reloads when required amount exceeds single reload", async () => {
    // Override costs-client to return a large required amount
    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue("3700.0000000000");

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
      balance_cents: "4200.0000000000", // 200 + 4000
      required_cents: "3700.0000000000",
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
      balance_cents: "50.0000000000",
      required_cents: "100.0000000000",
    });

    // Verify cancelled reload entry was written
    const reloadEntries = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.orgId, orgId),
          eq(transactions.source, "reload")
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
    await db.insert(transactions).values({
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

    // Back up the 50 cents with a confirmed grant entry.
    await db.insert(transactions).values({
      orgId,
      userId,
      type: "credit",
      amountCents: 50,
      status: "confirmed",
      source: "welcome",
      description: "Welcome credit",
    });

    // Insert an old cancelled reload entry (20 min ago)
    await db.insert(transactions).values({
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
    expect(res.body.balance_cents).toBe("2050.0000000000");
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalled();
  });

  it("retries auto-reload when a confirmed reload is more recent than cancelled", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 60,
      reloadAmountCents: 2000,
      reloadThresholdCents: 200,
      stripePaymentMethodId: "pm_123",
    });

    // Back up the grants history; account.creditBalanceCents owns the grant total.
    await db.insert(transactions).values({
      orgId,
      userId,
      type: "credit",
      amountCents: 50,
      status: "confirmed",
      source: "welcome",
      description: "Welcome credit",
    });

    // Insert a cancelled reload entry (3 min ago)
    await db.insert(transactions).values({
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
    await db.insert(transactions).values({
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

    // Last reload is confirmed → no cooldown → charges 2000.
    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);
    expect(res.body.balance_cents).toBe("2060.0000000000"); // 60 + 2000
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
    expect(res.body.balance_cents).toBe("200.0000000000");
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

  it("uses billing grant total minus runs-service total, not ledger reconciliation", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      creditBalanceCents: 999,
    });

    // Historical grant rows are not reconciled during authorize anymore.
    await db.insert(transactions).values({
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
    expect(res.body.balance_cents).toBe("999.0000000000");
    expect(res.body.sufficient).toBe(true);
  });
});

describe("Credits authorize — reload concurrency", () => {
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

  it("does not reconcile grant ledger rows during concurrent /authorize calls", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_race",
      creditBalanceCents: 999, // wrong cache
    });
    await db.insert(transactions).values({
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
    // Only the pre-existing welcome row should exist.
    const entries = await db
      .select()
      .from(transactions)
      .where(eq(transactions.orgId, orgId));
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("welcome");
  });

  it("inserts a single reload grant under N concurrent insufficient /authorize calls", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_race",
      stripePaymentMethodId: "pm_race",
      creditBalanceCents: 50,
      reloadAmountCents: 2000,
      reloadThresholdCents: 200,
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

    const reloadEntries = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.orgId, orgId),
          eq(transactions.source, "reload")
        )
      );
    expect(reloadEntries).toHaveLength(1);
    expect(reloadEntries[0].amountCents).toBe("2000.0000000000");
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate (org_id, stripe_payment_intent_id) reload rows at the DB level", async () => {
    await db.insert(transactions).values({
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
      db.insert(transactions).values({
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

});
