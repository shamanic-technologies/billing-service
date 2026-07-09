import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import {
  setupStripeMocks,
  customerWithDefaultPM,
} from "../helpers/mock-stripe.js";

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
    ssMocks.getCustomerByOrg.mockResolvedValue(customerWithDefaultPM());
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("1000.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "100.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: false });
    expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
  });

  it("no reload while the negative balance is within the credit line (postpaid)", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.getCustomerByOrg.mockResolvedValue(customerWithDefaultPM());
    // paid 0 → start tier floor -5000. spent 4000 → balance -4000, still above floor.
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "4000.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: false });
    expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
  });

  it("triggers reload when balance crosses the floor; charges the TIER amount not the stored daily", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.getCustomerByOrg.mockResolvedValue(customerWithDefaultPM());
    // paid 0 → floor -5000, tier amount 5000. spent 5001 → balance -5001 < -5000 → reload.
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "5001.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: true });
    expect(ssMocks.reloadViaPaymentIntent).toHaveBeenCalledTimes(1);
    // Charge is the tier amount (5000), NOT the stored daily topup_amount (1000).
    expect(ssMocks.reloadViaPaymentIntent.mock.calls[0]?.[1]).toBe(5000);
  });

  it("triggers reload when card attached but no default PM (regression)", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    // Customer has no default_payment_method, but a card is attached.
    ssMocks.getCustomerByOrg.mockResolvedValue(customerWithDefaultPM({ invoice_settings: { default_payment_method: null } }));
    ssMocks.hasAttachedCardPm.mockResolvedValue(true);
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "5001.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: true });
    expect(ssMocks.reloadViaPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("does not topup when no card attached", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.hasAttachedCardPm.mockResolvedValue(false);
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("100.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "50.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: false });
    expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
  });

  it("does not topup for an India-issued card (off_session mandate unsupported)", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.hasAttachedCardPm.mockResolvedValue(true);
    ssMocks.getOrgCardCountry.mockResolvedValue("IN");
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("100.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "50.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: false });
    expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
  });

  it("does not topup when no topup config", async () => {
    await insertTestAccount({ orgId });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "100.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body.topup_triggered).toBe(false);
    expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
  });

  it("topup_triggered=false when reload returns failed", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.getCustomerByOrg.mockResolvedValue(customerWithDefaultPM());
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");
    ssMocks.reloadViaPaymentIntent.mockResolvedValue({
      status: "failed",
      failure_reason: "decline",
    });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "5001.0000000000" });

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
