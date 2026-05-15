import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { db } from "../../src/db/index.js";
import { customerBalanceTransactions } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

const orgId = "00000000-0000-0000-0000-00000000b001";
const userId = "00000000-0000-0000-0000-000000000099";

describe("POST /v1/customer_balance/usage_apply — proactive topup hint from runs-service", () => {
  const app = createTestApp();
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

  it("acknowledges no-op when available >= topup_threshold", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_no_topup",
      stripePaymentMethodId: "pm_no_topup",
      topupAmountCents: 1000,
      topupThresholdCents: 500,
      balanceCents: 1000,
    });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "100.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: false });
    expect(stripeMocks.chargePaymentMethod).not.toHaveBeenCalled();
    const rows = await db.select().from(customerBalanceTransactions);
    expect(rows).toHaveLength(0);
  });

  it("triggers topup when available < topup_threshold and topup configured", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_topup",
      stripePaymentMethodId: "pm_topup",
      topupAmountCents: 1000,
      topupThresholdCents: 500,
      balanceCents: 600,
    });

    // available = 600 - 200 = 400 < threshold 500 → fire topup
    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "200.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: true });
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalledTimes(1);
    expect(stripeMocks.createBalanceTransaction).not.toHaveBeenCalled();

    const rows = await db.select().from(customerBalanceTransactions);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("payment");
    expect(rows[0].status).toBe("succeeded");
    expect(rows[0].amountCents).toBe("-1000.0000000000");
  });

  it("does not topup when no payment method configured", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_no_pm",
      topupAmountCents: 1000,
      topupThresholdCents: 500,
      balanceCents: 100,
    });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "50.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: false });
    expect(stripeMocks.chargePaymentMethod).not.toHaveBeenCalled();
  });

  it("respects 15-minute cooldown after a canceled payment", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_cooldown",
      stripePaymentMethodId: "pm_cooldown",
      topupAmountCents: 1000,
      topupThresholdCents: 500,
      balanceCents: 600,
    });

    await db.insert(customerBalanceTransactions).values({
      orgId,
      userId,
      type: "payment",
      amountCents: "-1000.0000000000",
      status: "canceled",
      description: "previous failed topup",
    });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "200.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: false });
    expect(stripeMocks.chargePaymentMethod).not.toHaveBeenCalled();
  });

  it("records canceled payment row when Stripe charge fails", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_fail",
      stripePaymentMethodId: "pm_fail",
      topupAmountCents: 1000,
      topupThresholdCents: 500,
      balanceCents: 600,
    });

    stripeMocks.chargePaymentMethod.mockRejectedValueOnce(new Error("card declined"));

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "200.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: false });

    const rows = await db
      .select()
      .from(customerBalanceTransactions)
      .where(eq(customerBalanceTransactions.type, "payment"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("canceled");
  });

  it("returns 400 on invalid spent_total_cents", async () => {
    await insertTestAccount({ orgId, balanceCents: 100 });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "not-a-number" });

    expect(res.status).toBe(400);
  });

  it("returns 400 on negative spent_total_cents", async () => {
    await insertTestAccount({ orgId, balanceCents: 100 });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "-1.0000000000" });

    expect(res.status).toBe(400);
  });
});
