import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestAccount,
  closeDb,
} from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";

const orgId = "00000000-0000-0000-0000-00000000b101";
const unknownOrgId = "00000000-0000-0000-0000-00000000b999";

const apiKeyHeaders = { "X-API-Key": "test-api-key" };

function balancePath(id: string) {
  return `/internal/accounts/by-org/${id}/balance`;
}

describe("GET /internal/accounts/by-org/:orgId/balance (user-less balance read)", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let setUsage: (cents: string) => void;
  let setActualUsage: (cents: string) => void;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@acme.test"));
    await cleanTestData();

    const runsClient = await import("../../src/lib/runs-client.js");
    let usage = "0.0000000000";
    let actualUsage = "0.0000000000";
    setUsage = (cents: string) => {
      usage = cents;
    };
    setActualUsage = (cents: string) => {
      actualUsage = cents;
    };
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage,
      as_of: "2026-07-01T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async () => ({
      spent_cents: actualUsage,
    }));
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("404 when the org has no billing account (no side effects)", async () => {
    const res = await request(app).get(balancePath(unknownOrgId)).set(apiKeyHeaders);

    expect(res.status).toBe(404);
    // Pure read: no balance compose for a non-existent account.
    expect(ssMocks.fetchOrgCustomer).not.toHaveBeenCalled();
    expect(ssMocks.reloadViaInvoice).not.toHaveBeenCalled();
  });

  it("200 with same shape as /v1/accounts/balance (credited − usage)", async () => {
    await insertTestAccount({ orgId });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("100.0000000000");
    setUsage("40.0000000000"); // balance = 100 − 40 = 60
    setActualUsage("30.0000000000"); // actual balance = 100 − 30 = 70

    const res = await request(app).get(balancePath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      balance_cents: "60.0000000000",
      actual_balance_cents: "70.0000000000",
      depleted: false,
      // No topup config on the default account → auto-topup not enabled.
      has_auto_topup: false,
    });
    // User-less balance path: keyed off orgId ONLY (no x-user-id / sentinel).
    expect(ssMocks.fetchOrgCustomer).toHaveBeenCalledWith(orgId);
    // Pure read: never reloads.
    expect(ssMocks.reloadViaInvoice).not.toHaveBeenCalled();
  });

  it("has_auto_topup=true when topup configured + chargeable card + supported country", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 5000,
      topupThresholdCents: -5000,
    });
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");

    const res = await request(app).get(balancePath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.has_auto_topup).toBe(true);
    // Pure read: still never reloads, even for an auto-topup-enabled org.
    expect(ssMocks.reloadViaInvoice).not.toHaveBeenCalled();
  });

  it("has_auto_topup=false when topup configured but no chargeable card", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 5000,
      topupThresholdCents: -5000,
    });
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);

    const res = await request(app).get(balancePath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.has_auto_topup).toBe(false);
  });

  it("has_auto_topup=false when the card's issuing country is off_session-blocked (e.g. India)", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 5000,
      topupThresholdCents: -5000,
    });
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("IN");

    const res = await request(app).get(balancePath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.has_auto_topup).toBe(false);
  });

  it("depleted=true when spendable balance <= 0", async () => {
    await insertTestAccount({ orgId });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("10.0000000000");
    setUsage("50.0000000000"); // balance = 10 − 50 = −40
    setActualUsage("50.0000000000");

    const res = await request(app).get(balancePath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.balance_cents).toBe("-40.0000000000");
    expect(res.body.depleted).toBe(true);
  });

  it("fails loud (502) when runs-service is unreachable", async () => {
    await insertTestAccount({ orgId });
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockRejectedValue(
      new Error("runs-service down")
    );

    const res = await request(app).get(balancePath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(502);
  });

  it("rejects a non-UUID orgId with 400", async () => {
    const res = await request(app).get(balancePath("not-a-uuid")).set(apiKeyHeaders);
    expect(res.status).toBe(400);
  });

  it("requires service auth (401 without x-api-key)", async () => {
    const res = await request(app).get(balancePath(orgId));
    expect(res.status).toBe(401);
  });
});
