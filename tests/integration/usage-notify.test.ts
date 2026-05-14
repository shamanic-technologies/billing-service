import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { db } from "../../src/db/index.js";
import { transactions } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

const orgId = "00000000-0000-0000-0000-00000000b001";
const userId = "00000000-0000-0000-0000-000000000099";

describe("POST /v1/credits/usage-notify — proactive reload hint from runs-service", () => {
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

  it("acknowledges no-op when available >= reload_threshold", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_no_reload",
      stripePaymentMethodId: "pm_no_reload",
      reloadAmountCents: 1000,
      reloadThresholdCents: 500,
      creditBalanceCents: 1000,
    });

    const res = await request(app)
      .post("/v1/credits/usage-notify")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "100.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, reload_triggered: false });
    expect(stripeMocks.chargePaymentMethod).not.toHaveBeenCalled();
    const rows = await db.select().from(transactions);
    expect(rows).toHaveLength(0);
  });

  it("triggers reload when available < reload_threshold and reload configured", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_reload",
      stripePaymentMethodId: "pm_reload",
      reloadAmountCents: 1000,
      reloadThresholdCents: 500,
      creditBalanceCents: 600,
    });

    // available = 600 - 200 = 400 < threshold 500 → fire reload
    const res = await request(app)
      .post("/v1/credits/usage-notify")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "200.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, reload_triggered: true });
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalledTimes(1);
    expect(stripeMocks.createBalanceTransaction).not.toHaveBeenCalled();

    const rows = await db.select().from(transactions);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("reload");
    expect(rows[0].type).toBe("credit");
    expect(rows[0].status).toBe("confirmed");
    expect(rows[0].amountCents).toBe("1000.0000000000");
  });

  it("does not reload when no payment method configured", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_no_pm",
      reloadAmountCents: 1000,
      reloadThresholdCents: 500,
      creditBalanceCents: 100,
    });

    const res = await request(app)
      .post("/v1/credits/usage-notify")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "50.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, reload_triggered: false });
    expect(stripeMocks.chargePaymentMethod).not.toHaveBeenCalled();
  });

  it("respects 15-minute cooldown after a cancelled reload", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_cooldown",
      stripePaymentMethodId: "pm_cooldown",
      reloadAmountCents: 1000,
      reloadThresholdCents: 500,
      creditBalanceCents: 600,
    });

    await db.insert(transactions).values({
      orgId,
      userId,
      type: "credit",
      amountCents: "1000.0000000000",
      status: "cancelled",
      source: "reload",
      description: "previous failed reload",
    });

    const res = await request(app)
      .post("/v1/credits/usage-notify")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "200.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, reload_triggered: false });
    expect(stripeMocks.chargePaymentMethod).not.toHaveBeenCalled();
  });

  it("records cancelled reload row when Stripe charge fails", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_fail",
      stripePaymentMethodId: "pm_fail",
      reloadAmountCents: 1000,
      reloadThresholdCents: 500,
      creditBalanceCents: 600,
    });

    stripeMocks.chargePaymentMethod.mockRejectedValueOnce(new Error("card declined"));

    const res = await request(app)
      .post("/v1/credits/usage-notify")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "200.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, reload_triggered: false });

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.source, "reload"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("cancelled");
  });

  it("returns 400 on invalid spent_total_cents", async () => {
    await insertTestAccount({ orgId, creditBalanceCents: 100 });

    const res = await request(app)
      .post("/v1/credits/usage-notify")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "not-a-number" });

    expect(res.status).toBe(400);
  });

  it("returns 400 on negative spent_total_cents", async () => {
    await insertTestAccount({ orgId, creditBalanceCents: 100 });

    const res = await request(app)
      .post("/v1/credits/usage-notify")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "-1.0000000000" });

    expect(res.status).toBe(400);
  });
});
