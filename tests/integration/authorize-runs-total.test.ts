import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { db } from "../../src/db/index.js";
import { transactions } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

const orgId = "00000000-0000-0000-0000-00000000a001";
const userId = "00000000-0000-0000-0000-000000000099";

const authorizeBody = {
  items: [{ costName: "anthropic-sonnet-4-5-tokens-input", quantity: 1000 }],
  description: "runs-total authorize test",
};

describe("Credits authorize — billing grants minus runs-service spent total", () => {
  const app = createTestApp();
  let stripeMocks: ReturnType<typeof setupStripeMocks>;
  let fetchRunsOrgUsageTotalSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    stripeMocks = setupStripeMocks();
    await cleanTestData();

    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue("10.0000000000");

    const runsClient = await import("../../src/lib/runs-client.js");
    fetchRunsOrgUsageTotalSpy = vi.fn().mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-05-13T00:00:00.000Z",
    });
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(
      fetchRunsOrgUsageTotalSpy
    );
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("authorizes from granted credits minus runs spent total", async () => {
    await insertTestAccount({ orgId, stripeCustomerId: "cus_auth", creditBalanceCents: 100 });
    fetchRunsOrgUsageTotalSpy.mockResolvedValue({
      org_id: orgId,
      spent_cents: "40.0000000000",
      as_of: "2026-05-13T00:00:00.000Z",
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId, userId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sufficient: true,
      balance_cents: "60.0000000000",
      required_cents: "10.0000000000",
    });
    expect(fetchRunsOrgUsageTotalSpy).toHaveBeenCalledWith(orgId, expect.any(Object));
    expect(stripeMocks.createBalanceTransaction).not.toHaveBeenCalled();
  });

  it("returns insufficient when grants minus runs spent cannot cover required cost", async () => {
    await insertTestAccount({ orgId, stripeCustomerId: "cus_insufficient", creditBalanceCents: 100 });
    fetchRunsOrgUsageTotalSpy.mockResolvedValue({
      org_id: orgId,
      spent_cents: "95.0000000000",
      as_of: "2026-05-13T00:00:00.000Z",
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId, userId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sufficient: false,
      balance_cents: "5.0000000000",
      required_cents: "10.0000000000",
    });
    expect(stripeMocks.chargePaymentMethod).not.toHaveBeenCalled();
  });

  it("auto-reloads once and records a Stripe top-up grant without Stripe customer balance sync", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_reload",
      stripePaymentMethodId: "pm_reload",
      reloadAmountCents: 1000,
      creditBalanceCents: 100,
    });
    fetchRunsOrgUsageTotalSpy.mockResolvedValue({
      org_id: orgId,
      spent_cents: "95.0000000000",
      as_of: "2026-05-13T00:00:00.000Z",
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId, userId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sufficient: true,
      balance_cents: "1005.0000000000",
      required_cents: "10.0000000000",
    });
    expect(stripeMocks.chargePaymentMethod).toHaveBeenCalledTimes(1);
    expect(stripeMocks.createBalanceTransaction).not.toHaveBeenCalled();

    const rows = await db.select().from(transactions);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("reload");
    expect(rows[0].type).toBe("credit");
    expect(rows[0].amountCents).toBe("1000.0000000000");
  });

  it("fails loud when runs-service total is unavailable", async () => {
    await insertTestAccount({ orgId, stripeCustomerId: "cus_runs_down", creditBalanceCents: 100 });
    fetchRunsOrgUsageTotalSpy.mockRejectedValue(new Error("runs-service down"));

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId, userId))
      .send(authorizeBody);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Failed to fetch usage total from runs-service");
  });

  it("removes billing provision lifecycle endpoints", async () => {
    const headers = getAuthHeaders(orgId, userId);

    const deduct = await request(app)
      .post("/v1/credits/deduct")
      .set(headers)
      .send({ amount_cents: "1.0000000000", description: "deleted" });
    const provision = await request(app)
      .post("/v1/credits/provision")
      .set(headers)
      .send({ amount_cents: "1.0000000000", description: "deleted" });
    const confirm = await request(app)
      .post("/v1/credits/provision/00000000-0000-0000-0000-00000000ffff/confirm")
      .set(headers)
      .send({});
    const cancel = await request(app)
      .post("/v1/credits/provision/00000000-0000-0000-0000-00000000ffff/cancel")
      .set(headers)
      .send({});

    expect(deduct.status).toBe(404);
    expect(provision.status).toBe(404);
    expect(confirm.status).toBe(404);
    expect(cancel.status).toBe(404);
  });
});
