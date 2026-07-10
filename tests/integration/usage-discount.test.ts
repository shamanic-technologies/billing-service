import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
// Single file-scope pool teardown — two describe blocks share ONE pg pool, so
// only close it once after both finish (a per-describe closeDb ends the pool
// early and the second block's queries fail with CONNECTION_ENDED).
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestAccount,
  insertTestUsageDiscount,
  closeDb,
} from "../helpers/test-db.js";
import { setupStripeMocks, customerWithDefaultPM } from "../helpers/mock-stripe.js";

const orgId = "00000000-0000-0000-0000-0000000dd001";
const userId = "00000000-0000-0000-0000-000000000099";
const apiKey = { "X-API-Key": "test-api-key" };

function orgHeaders(email?: string) {
  const h: Record<string, string> = {
    "X-API-Key": "test-api-key",
    "x-org-id": orgId,
    "Content-Type": "application/json",
  };
  if (email) h["x-email"] = email;
  return h;
}

afterAll(async () => {
  await closeDb();
});

describe("Staff usage-discount CRUD (/v1/usage-discount)", () => {
  const app = createTestApp();

  beforeEach(async () => {
    vi.restoreAllMocks();
    setupStripeMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
  });

  it("GET returns discountPct=null when no discount is set", async () => {
    const res = await request(app).get("/v1/usage-discount").set(orgHeaders());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orgId, discountPct: null, setBy: null, setAt: null });
  });

  it("PUT sets a discount and records setBy; GET reflects it", async () => {
    const put = await request(app)
      .put("/v1/usage-discount")
      .set(orgHeaders("staff@distribute.you"))
      .send({ discountPct: 50 });
    expect(put.status).toBe(200);
    expect(put.body.orgId).toBe(orgId);
    expect(put.body.discountPct).toBe(50);
    expect(put.body.setBy).toBe("staff@distribute.you");
    expect(typeof put.body.setAt).toBe("string");

    const get = await request(app).get("/v1/usage-discount").set(orgHeaders());
    expect(get.status).toBe(200);
    expect(get.body.discountPct).toBe(50);
    expect(get.body.setBy).toBe("staff@distribute.you");
  });

  it("PUT replaces the single value (no stacking)", async () => {
    await request(app).put("/v1/usage-discount").set(orgHeaders()).send({ discountPct: 30 });
    await request(app).put("/v1/usage-discount").set(orgHeaders()).send({ discountPct: 70 });

    const get = await request(app).get("/v1/usage-discount").set(orgHeaders());
    expect(get.body.discountPct).toBe(70);
  });

  it("accepts boundary values 0 and 100", async () => {
    const zero = await request(app).put("/v1/usage-discount").set(orgHeaders()).send({ discountPct: 0 });
    expect(zero.status).toBe(200);
    expect(zero.body.discountPct).toBe(0);

    const hundred = await request(app).put("/v1/usage-discount").set(orgHeaders()).send({ discountPct: 100 });
    expect(hundred.status).toBe(200);
    expect(hundred.body.discountPct).toBe(100);
  });

  it("DELETE removes the discount (→ null); GET returns null", async () => {
    await insertTestUsageDiscount({ orgId, discountPct: 40, setBy: "x@y.z" });

    const del = await request(app).delete("/v1/usage-discount").set(orgHeaders());
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ orgId, discountPct: null, setBy: null, setAt: null });

    const get = await request(app).get("/v1/usage-discount").set(orgHeaders());
    expect(get.body.discountPct).toBeNull();
  });

  it("DELETE is idempotent when no discount exists", async () => {
    const del = await request(app).delete("/v1/usage-discount").set(orgHeaders());
    expect(del.status).toBe(200);
    expect(del.body.discountPct).toBeNull();
  });

  it("rejects an out-of-range percentage (fail loud, no clamp)", async () => {
    const over = await request(app).put("/v1/usage-discount").set(orgHeaders()).send({ discountPct: 150 });
    expect(over.status).toBe(400);

    const neg = await request(app).put("/v1/usage-discount").set(orgHeaders()).send({ discountPct: -10 });
    expect(neg.status).toBe(400);

    // Nothing was persisted by a rejected request.
    const get = await request(app).get("/v1/usage-discount").set(orgHeaders());
    expect(get.body.discountPct).toBeNull();
  });

  it("rejects a non-integer percentage", async () => {
    const res = await request(app).put("/v1/usage-discount").set(orgHeaders()).send({ discountPct: 12.5 });
    expect(res.status).toBe(400);
  });

  it("rejects a missing discountPct (no default)", async () => {
    const res = await request(app).put("/v1/usage-discount").set(orgHeaders()).send({});
    expect(res.status).toBe(400);
  });

  it("401 without service auth (GET/PUT/DELETE)", async () => {
    expect((await request(app).get("/v1/usage-discount").set({ "x-org-id": orgId })).status).toBe(401);
    expect(
      (await request(app).put("/v1/usage-discount").set({ "x-org-id": orgId }).send({ discountPct: 10 })).status
    ).toBe(401);
    expect((await request(app).delete("/v1/usage-discount").set({ "x-org-id": orgId })).status).toBe(401);
  });

  it("400 when x-org-id is missing or not a UUID", async () => {
    expect((await request(app).get("/v1/usage-discount").set(apiKey)).status).toBe(400);
    expect(
      (await request(app).put("/v1/usage-discount").set({ ...apiKey, "x-org-id": "nope" }).send({ discountPct: 10 }))
        .status
    ).toBe(400);
  });
});

describe("Usage discount is NOT applied at balance composition (frozen in runs-service)", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let setUsage: (c: string) => void;
  let setActualUsage: (c: string) => void;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();

    const runsClient = await import("../../src/lib/runs-client.js");
    let usage = "0.0000000000";
    let actualUsage = "0.0000000000";
    setUsage = (c) => { usage = c; };
    setActualUsage = (c) => { actualUsage = c; };
    // runs-service serves NET usage (discount already applied at cost-write).
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
  });

  it("GET /v1/accounts: exposes usage_discount_pct but balance subtracts runs usage verbatim (no billing-side discount, no net_* fields)", async () => {
    await insertTestAccount({ orgId });
    await insertTestUsageDiscount({ orgId, discountPct: 50 });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("1000.0000000000");
    // runs already served net usage; billing does not touch it.
    setUsage("50.0000000000");
    setActualUsage("40.0000000000");

    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId, userId));

    expect(res.status).toBe(200);
    // Discount pct is exposed for the dashboard banner.
    expect(res.body.usage_discount_pct).toBe(50);
    // No billing-side discount math: usage_cents = runs usage; balance = credited − usage.
    expect(res.body.usage_cents).toBe("50.0000000000");
    expect(res.body.balance_cents).toBe("950.0000000000");
    expect(res.body.actual_balance_cents).toBe("960.0000000000");
    // Superseded #246 net fields are gone.
    expect(res.body.net_usage_cents).toBeUndefined();
    expect(res.body.net_actual_usage_cents).toBeUndefined();
  });

  it("GET /v1/accounts: no discount → null pct, balance unchanged", async () => {
    await insertTestAccount({ orgId });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("1000.0000000000");
    setUsage("100.0000000000");
    setActualUsage("100.0000000000");

    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId, userId));

    expect(res.status).toBe(200);
    expect(res.body.usage_discount_pct).toBeNull();
    expect(res.body.usage_cents).toBe("100.0000000000");
    expect(res.body.balance_cents).toBe("900.0000000000");
    expect(res.body.actual_balance_cents).toBe("900.0000000000");
  });

  it("GET /v1/accounts: a set discount does NOT change balance vs no discount (same runs usage)", async () => {
    await insertTestAccount({ orgId });
    await insertTestUsageDiscount({ orgId, discountPct: 50 });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("1000.0000000000");
    setUsage("100.0000000000");
    setActualUsage("100.0000000000");

    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId, userId));

    expect(res.status).toBe(200);
    // Identical balance to the no-discount case above — billing applies nothing.
    expect(res.body.balance_cents).toBe("900.0000000000");
    expect(res.body.actual_balance_cents).toBe("900.0000000000");
  });

  it("GET /internal/accounts/by-org/:orgId/balance subtracts runs usage verbatim (discount ignored)", async () => {
    await insertTestAccount({ orgId });
    await insertTestUsageDiscount({ orgId, discountPct: 50 });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("100.0000000000");
    setUsage("80.0000000000");
    setActualUsage("80.0000000000");

    const res = await request(app)
      .get(`/internal/accounts/by-org/${orgId}/balance`)
      .set(apiKey);

    expect(res.status).toBe(200);
    // 100 − 80 = 20; the 50% discount is NOT applied here (would have been 60 under #246).
    expect(res.body.balance_cents).toBe("20.0000000000");
    expect(res.body.actual_balance_cents).toBe("20.0000000000");
    expect(res.body.depleted).toBe(false);
  });

  it("authorize: a discount does NOT change the sufficiency verdict (billing applies nothing)", async () => {
    await insertTestAccount({ orgId }); // no topup config → credit-line floor "0"
    await insertTestUsageDiscount({ orgId, discountPct: 50 });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("100.0000000000");
    setUsage("80.0000000000");

    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue("30.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId, userId))
      .send({ items: [{ costName: "x", quantity: 1 }] });

    expect(res.status).toBe(200);
    // balance 100 − 80 = 20; 20 − 30 = −10 < 0 → insufficient. The discount is NOT
    // applied (under #246 net usage 40 → balance 60 would have been sufficient).
    expect(res.body.sufficient).toBe(false);
    expect(res.body.balance_cents).toBe("20.0000000000");
  });

  it("usage_apply: spent_total_cents (already net from runs) is used verbatim; discount does not suppress the topup", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    await insertTestUsageDiscount({ orgId, discountPct: 50 });
    ssMocks.getCustomerByOrg.mockResolvedValue(customerWithDefaultPM());
    // paid 0 → start tier floor -5000. runs reports net spend 6000 → balance −6000
    // (past the floor) → reload fires. Billing does NOT re-discount the 6000.
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");
    ssMocks.reloadViaPaymentIntent.mockResolvedValue({ status: "succeeded", payment_intent_id: "pi_x" });

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "6000.0000000000" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ acknowledged: true, topup_triggered: true });
    expect(ssMocks.reloadViaPaymentIntent).toHaveBeenCalled();
  });
});

describe("Internal usage-discount read for runs-service (GET /internal/accounts/by-org/:orgId/usage-discount)", () => {
  const app = createTestApp();

  beforeEach(async () => {
    vi.restoreAllMocks();
    setupStripeMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
  });

  it("returns discountPct=null when the org has no discount", async () => {
    const res = await request(app)
      .get(`/internal/accounts/by-org/${orgId}/usage-discount`)
      .set(apiKey);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orgId, discountPct: null });
  });

  it("returns the stored discountPct (user-less, orgId in PATH)", async () => {
    await insertTestUsageDiscount({ orgId, discountPct: 40, setBy: "staff@distribute.you" });
    const res = await request(app)
      .get(`/internal/accounts/by-org/${orgId}/usage-discount`)
      .set(apiKey);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orgId, discountPct: 40 });
  });

  it("401 without service auth", async () => {
    const res = await request(app).get(`/internal/accounts/by-org/${orgId}/usage-discount`);
    expect(res.status).toBe(401);
  });

  it("400 on a non-UUID orgId", async () => {
    const res = await request(app)
      .get("/internal/accounts/by-org/not-a-uuid/usage-discount")
      .set(apiKey);
    expect(res.status).toBe(400);
  });
});
