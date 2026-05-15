import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

const orgId = "00000000-0000-0000-0000-00000000b001";
const userId = "00000000-0000-0000-0000-000000000099";

describe("POST /v1/customer_balance/usage_apply — proactive topup hint", () => {
  const app = createTestApp();
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

  it("no-op when available >= topup_threshold", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.getBalance.mockResolvedValue({ balance_cents: "1000.0000000000" });
    ssMocks.hasPaymentMethod.mockResolvedValue({ has_payment_method: true });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "100.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: false });
    expect(ssMocks.reload).not.toHaveBeenCalled();
  });

  it("triggers reload when available < threshold and PM present", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.getBalance.mockResolvedValue({ balance_cents: "600.0000000000" });
    ssMocks.hasPaymentMethod.mockResolvedValue({ has_payment_method: true });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "200.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: true });
    expect(ssMocks.reload).toHaveBeenCalledTimes(1);
  });

  it("does not topup when PM missing", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.getBalance.mockResolvedValue({ balance_cents: "100.0000000000" });
    ssMocks.hasPaymentMethod.mockResolvedValue({ has_payment_method: false });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "50.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: false });
    expect(ssMocks.reload).not.toHaveBeenCalled();
  });

  it("does not topup when no topup config", async () => {
    await insertTestAccount({ orgId });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "100.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body.topup_triggered).toBe(false);
    expect(ssMocks.reload).not.toHaveBeenCalled();
  });

  it("topup_triggered=false when SS.reload returns failed", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.getBalance.mockResolvedValue({ balance_cents: "600.0000000000" });
    ssMocks.hasPaymentMethod.mockResolvedValue({ has_payment_method: true });
    ssMocks.reload.mockResolvedValue({ status: "failed", failure_reason: "decline" });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "200.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: false });
  });

  it("returns 400 on invalid spent_total_cents", async () => {
    await insertTestAccount({ orgId });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "not-a-number" });

    expect(res.status).toBe(400);
  });

  it("returns 400 on negative spent_total_cents", async () => {
    await insertTestAccount({ orgId });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "-1.0000000000" });

    expect(res.status).toBe(400);
  });
});
