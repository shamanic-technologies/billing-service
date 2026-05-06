import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { transactions, billingAccounts } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

// Verifies the fractional-cents pivot: numeric(16,10) ledger + ceil-delta Stripe sync.
// Spec: see Definition of Done items #1-5 + AC-A through AC-F.

describe("Fractional cents — deduct accepts decimal input", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-00000000fc01";

  beforeEach(async () => {
    vi.restoreAllMocks();
    setupStripeMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
  });

  it("accepts decimal string '0.42' (AC-B1)", async () => {
    await insertTestAccount({ orgId, stripeCustomerId: "cus_a", creditBalanceCents: 200 });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({ amount_cents: "0.42", description: "fractional-string" });

    expect(res.status).toBe(200);
    expect(res.body.balance_cents).toBe("199.5800000000");

    const [entry] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.orgId, orgId), eq(transactions.source, "charge")));
    expect(entry.amountCents).toBe("0.4200000000");
  });

  it("accepts decimal number 0.42 (AC-B1)", async () => {
    await insertTestAccount({ orgId, stripeCustomerId: "cus_a", creditBalanceCents: 200 });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({ amount_cents: 0.42, description: "fractional-number" });

    expect(res.status).toBe(200);
    expect(res.body.balance_cents).toBe("199.5800000000");
  });

  it("integer input reads back as numeric.0000000000 (AC-B3)", async () => {
    await insertTestAccount({ orgId, stripeCustomerId: "cus_a", creditBalanceCents: 200 });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({ amount_cents: 100, description: "int-in" });

    expect(res.status).toBe(200);
    const [entry] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.orgId, orgId), eq(transactions.source, "charge")));
    expect(entry.amountCents).toBe("100.0000000000");
  });

  it("rejects negative amount (AC-B1)", async () => {
    await insertTestAccount({ orgId, stripeCustomerId: "cus_a", creditBalanceCents: 200 });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({ amount_cents: -1, description: "neg" });

    expect(res.status).toBe(400);
  });

  it("rejects NaN / non-numeric string (AC-B1)", async () => {
    await insertTestAccount({ orgId, stripeCustomerId: "cus_a", creditBalanceCents: 200 });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({ amount_cents: "abc", description: "bad" });

    expect(res.status).toBe(400);
  });

  it("rejects zero (AC-B1)", async () => {
    await insertTestAccount({ orgId, stripeCustomerId: "cus_a", creditBalanceCents: 200 });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({ amount_cents: 0, description: "zero" });

    expect(res.status).toBe(400);
  });

  it("rejects integer part > 16 digits (AC-B1)", async () => {
    await insertTestAccount({ orgId, stripeCustomerId: "cus_a", creditBalanceCents: 200 });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({ amount_cents: "99999999999999999", description: "huge" });

    expect(res.status).toBe(400);
  });
});

describe("Fractional cents — provision + confirm with fractional", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-00000000fc02";

  beforeEach(async () => {
    vi.restoreAllMocks();
    setupStripeMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
  });

  it("provisions fractional 0.123 then confirms with fractional 0.456 — balance preserves precision", async () => {
    await insertTestAccount({ orgId, stripeCustomerId: "cus_a", creditBalanceCents: 200 });

    const provRes = await request(app)
      .post("/v1/credits/provision")
      .set(getAuthHeaders(orgId))
      .send({ amount_cents: "0.123", description: "frac-prov" });

    expect(provRes.status).toBe(200);
    expect(provRes.body.balance_cents).toBe("199.8770000000");
    const provisionId = provRes.body.provision_id;

    const confRes = await request(app)
      .post(`/v1/credits/provision/${provisionId}/confirm`)
      .set(getAuthHeaders(orgId))
      .send({ actual_amount_cents: "0.456" });

    expect(confRes.status).toBe(200);
    // Net: 200 - 0.456 = 199.544
    expect(confRes.body.balance_cents).toBe("199.5440000000");
    expect(confRes.body.original_amount_cents).toBe("0.1230000000");
    expect(confRes.body.final_amount_cents).toBe("0.4560000000");
    expect(confRes.body.adjustment_cents).toBe("-0.3330000000");
  });
});

describe("Fractional cents — stress: precision retention", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-00000000fc03";

  beforeEach(async () => {
    vi.restoreAllMocks();
    setupStripeMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
  });

  it("AC-F1: 100 deducts of 0.0001 from 5.7531 → final exactly 5.7431", async () => {
    await insertTestAccount({ orgId, stripeCustomerId: "cus_a", creditBalanceCents: 5.7531 });

    let last;
    for (let i = 0; i < 100; i++) {
      last = await request(app)
        .post("/v1/credits/deduct")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: "0.0001", description: `tick-${i}` });
      expect(last.status).toBe(200);
    }
    expect(last!.body.balance_cents).toBe("5.7431000000");
  });

  it("AC-F3: mixed 10×0.0001 + 10×0.4 from 5.7531 → final exactly 1.7521", async () => {
    await insertTestAccount({ orgId, stripeCustomerId: "cus_a", creditBalanceCents: 5.7531 });

    let last;
    for (let i = 0; i < 10; i++) {
      last = await request(app)
        .post("/v1/credits/deduct")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: "0.0001", description: `mini-${i}` });
    }
    for (let i = 0; i < 10; i++) {
      last = await request(app)
        .post("/v1/credits/deduct")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: "0.4", description: `big-${i}` });
    }
    // 5.7531 - 10*0.0001 - 10*0.4 = 5.7531 - 0.001 - 4 = 1.7521
    expect(last!.body.balance_cents).toBe("1.7521000000");
  });
});

describe("Fractional cents — Stripe ceil-boundary sync", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-00000000fc04";
  let stripeMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    stripeMocks = setupStripeMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
  });

  it("AC-C1: deduct that crosses ceil-cent boundary fires Stripe call (delta=1)", async () => {
    // bal 1.5 → deduct 0.6 → bal 0.9. ceil(1.5)=2, ceil(0.9)=1. Delta=+1.
    await insertTestAccount({ orgId, stripeCustomerId: "cus_a", creditBalanceCents: 1.5 });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({ amount_cents: "0.6", description: "cross" });

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    expect(stripeMocks.createBalanceTransaction).toHaveBeenCalledTimes(1);
    expect(stripeMocks.createBalanceTransaction).toHaveBeenCalledWith(
      orgId,
      expect.any(String),
      "cus_a",
      1, // ceil delta
      "cross",
      undefined,
      {}
    );
  });

  it("AC-C2: deduct that does NOT cross ceil-cent boundary skips Stripe call", async () => {
    // bal 1.5 → deduct 0.4 → bal 1.1. ceil(1.5)=2, ceil(1.1)=2. Delta=0 → skip.
    await insertTestAccount({ orgId, stripeCustomerId: "cus_a", creditBalanceCents: 1.5 });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({ amount_cents: "0.4", description: "no-cross" });

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    expect(stripeMocks.createBalanceTransaction).not.toHaveBeenCalled();
  });

  it("AC-C4: stripe_balance_txn_id stays null when no Stripe call fired", async () => {
    await insertTestAccount({ orgId, stripeCustomerId: "cus_a", creditBalanceCents: 1.5 });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({ amount_cents: "0.4", description: "no-stripe" });

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    const [entry] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.orgId, orgId), eq(transactions.source, "charge")));
    expect(entry.stripeBalanceTxnId).toBeNull();
  });

  it("AC-C4: stripe_balance_txn_id set when Stripe call fires", async () => {
    stripeMocks.createBalanceTransaction.mockResolvedValue({
      id: "cbtxn_set_id",
      amount: 1,
      currency: "usd",
      description: "x",
    });
    await insertTestAccount({ orgId, stripeCustomerId: "cus_a", creditBalanceCents: 1.5 });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({ amount_cents: "0.6", description: "with-stripe" });

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));

    const [entry] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.orgId, orgId), eq(transactions.source, "charge")));
    expect(entry.stripeBalanceTxnId).toBe("cbtxn_set_id");
  });

  it("AC-C3: Stripe failure does NOT fail the ledger op", async () => {
    stripeMocks.createBalanceTransaction.mockRejectedValue(new Error("boom"));
    await insertTestAccount({ orgId, stripeCustomerId: "cus_a", creditBalanceCents: 1.5 });

    const res = await request(app)
      .post("/v1/credits/deduct")
      .set(getAuthHeaders(orgId))
      .send({ amount_cents: "0.6", description: "stripe-fails" });

    expect(res.status).toBe(200);
    expect(res.body.balance_cents).toBe("0.9000000000");
  });

  it("100 sub-cent deducts that don't cross any boundary → 0 Stripe calls", async () => {
    await insertTestAccount({ orgId, stripeCustomerId: "cus_a", creditBalanceCents: 100 });

    for (let i = 0; i < 100; i++) {
      await request(app)
        .post("/v1/credits/deduct")
        .set(getAuthHeaders(orgId))
        .send({ amount_cents: "0.0001", description: `sub-${i}` });
    }
    await new Promise((r) => setTimeout(r, 100));

    // bal 100 → 99.99. ceil(100)=100, ceil(99.99)=100, delta=0 every step.
    expect(stripeMocks.createBalanceTransaction).not.toHaveBeenCalled();
  });
});

describe("Fractional cents — public-stats string repr", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-00000000fc05";
  const userId = "00000000-0000-0000-0000-000000000099";

  beforeEach(async () => {
    vi.restoreAllMocks();
    setupStripeMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("AC-D1: returns string-decimal sums that survive JSON round-trip without precision loss", async () => {
    await insertTestAccount({ orgId, creditBalanceCents: 100.1234567 });
    await db.insert(transactions).values([
      {
        orgId,
        userId,
        type: "credit",
        status: "confirmed",
        amountCents: "100.1234567",
        source: "reload",
        description: "frac-reload",
      },
      {
        orgId,
        userId,
        type: "debit",
        status: "confirmed",
        amountCents: "50.0000001",
        source: "charge",
        description: "frac-debit",
      },
    ]);

    const res = await request(app).get("/public/stats/billing");
    expect(res.status).toBe(200);

    // Strings, not numbers
    expect(typeof res.body.totalCreditBalanceCents).toBe("string");
    expect(typeof res.body.totalCreditedCents).toBe("string");
    expect(typeof res.body.totalConsumedCents).toBe("string");

    // Round-trip preserves precision
    const parsed = JSON.parse(JSON.stringify(res.body));
    expect(parsed.totalCreditedCents).toBe("100.1234567000");
    expect(parsed.totalConsumedCents).toBe("50.0000001000");
  });
});
