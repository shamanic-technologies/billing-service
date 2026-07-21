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
  let fetchRunsOrgUsageTotalSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();

    // usage_apply gates the reload on computeBalance (the SAME NET balance source
    // as authorize), NOT on the request's `spent_total_cents`. The body value is
    // the caller's GROSS usage and is ignored by the gate — so every test drives
    // the balance via the runs NET usage + the org-scoped paid topups.
    const runsClient = await import("../../src/lib/runs-client.js");
    fetchRunsOrgUsageTotalSpy = vi.fn().mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-07-21T00:00:00.000Z",
    });
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(
      fetchRunsOrgUsageTotalSpy
    );
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("no-op when net balance >= tier floor", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithDefaultPM());
    // paid 1000 → start tier floor -5000. usage 100 → balance +900, well above floor.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("1000.0000000000");
    fetchRunsOrgUsageTotalSpy.mockResolvedValue({
      org_id: orgId,
      spent_cents: "100.0000000000",
      as_of: "x",
    });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "100.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: false });
    expect(ssMocks.reloadViaInvoice).not.toHaveBeenCalled();
  });

  it("no reload while the negative balance is within the credit line (postpaid)", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithDefaultPM());
    // paid 0 → start tier floor -5000. usage 4000, credited 0 → balance -4000, still above floor.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    fetchRunsOrgUsageTotalSpy.mockResolvedValue({
      org_id: orgId,
      spent_cents: "4000.0000000000",
      as_of: "x",
    });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "4000.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: false });
    expect(ssMocks.reloadViaInvoice).not.toHaveBeenCalled();
  });

  it("triggers reload when NET balance crosses the floor; charges the TIER amount not the stored daily", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithDefaultPM());
    // paid 0 → floor -5000, tier amount 5000. usage 5001, credited 0 → balance -5001 < -5000 → reload.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    fetchRunsOrgUsageTotalSpy.mockResolvedValue({
      org_id: orgId,
      spent_cents: "5001.0000000000",
      as_of: "x",
    });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "5001.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: true });
    expect(ssMocks.reloadViaInvoice).toHaveBeenCalledTimes(1);
    // Charge is the tier amount (5000), NOT the stored daily topup_amount (1000).
    expect(ssMocks.reloadViaInvoice.mock.calls[0]?.[1]).toBe(5000);
  });

  it("the GROSS body spent_total_cents does NOT gate the reload — only the NET balance does (bug #285)", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithDefaultPM());
    // paid 0 → floor -5000. NET usage 100 → balance -100, well above floor.
    // The caller sends a huge GROSS spent_total (9999) — the OLD code would have
    // computed balance -9999 and fired an erroneous reload. It must NOT now.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    fetchRunsOrgUsageTotalSpy.mockResolvedValue({
      org_id: orgId,
      spent_cents: "100.0000000000",
      as_of: "x",
    });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "9999.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: false });
    expect(ssMocks.reloadViaInvoice).not.toHaveBeenCalled();
  });

  it("does not topup when no chargeable card attached", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    fetchRunsOrgUsageTotalSpy.mockResolvedValue({
      org_id: orgId,
      spent_cents: "5001.0000000000",
      as_of: "x",
    });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "5001.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: false });
    expect(ssMocks.reloadViaInvoice).not.toHaveBeenCalled();
  });

  it("does not topup for an India-issued card (off_session mandate unsupported)", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("IN");
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    fetchRunsOrgUsageTotalSpy.mockResolvedValue({
      org_id: orgId,
      spent_cents: "5001.0000000000",
      as_of: "x",
    });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "5001.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: false });
    expect(ssMocks.reloadViaInvoice).not.toHaveBeenCalled();
  });

  it("does not topup when no topup config", async () => {
    await insertTestAccount({ orgId });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "100.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body.topup_triggered).toBe(false);
    expect(ssMocks.reloadViaInvoice).not.toHaveBeenCalled();
  });

  it("topup_triggered=false when reload returns failed", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithDefaultPM());
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    fetchRunsOrgUsageTotalSpy.mockResolvedValue({
      org_id: orgId,
      spent_cents: "5001.0000000000",
      as_of: "x",
    });
    ssMocks.reloadViaInvoice.mockResolvedValue({
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
