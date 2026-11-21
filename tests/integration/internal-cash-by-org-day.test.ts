import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, insertTestPromoGrant, closeDb } from "../helpers/test-db.js";
import * as ssClient from "../../src/lib/stripe-service-client.js";

// SAAS-CASH-1121: cash per org per UTC day, gross headline + net, stripe-service rows
// plus billing's off-platform payments on their paid day.
const olive = "00000000-0000-4000-8000-00000000a11e";
const acme = "00000000-0000-4000-8000-00000000ac3e";
const userId = "00000000-0000-4000-8000-00000000a11f";
const apiKey = { "X-API-Key": "test-api-key" };

describe("GET /internal/cash/by-org-day", () => {
  const app = createTestApp();

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    vi.spyOn(ssClient, "getFleetCashByOrgDay").mockResolvedValue({
      asOf: "2026-11-21T14:05:29.000Z",
      totalGrossCents: "2500",
      totalNetCents: "2000",
      rows: [
        { orgId: acme, day: "2026-11-17", grossCents: "2500", netCents: "2500" },
        { orgId: acme, day: "2026-11-18", grossCents: "0", netCents: "-500" },
      ],
    });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("serves stripe-service rows plus off-platform payments, totals = Σ rows, net <= gross", async () => {
    await insertTestAccount({ orgId: olive });
    const grant = await insertTestPromoGrant({
      orgId: olive,
      userId,
      amountCents: 20000,
      promoCode: "admin_grant",
      description: "Client payment of $200 received directly",
    });
    const mark = await request(app)
      .post(`/internal/credits/grants/${grant.id}/off-platform-payment`)
      .set(apiKey)
      .send({ paidAt: "2026-09-28", recordedBy: "staff@distribute.you", note: "bank transfer" });
    expect(mark.status).toBe(200);

    const res = await request(app).get("/internal/cash/by-org-day").set(apiKey);
    expect(res.status).toBe(200);
    expect(res.body.as_of).toBe("2026-11-21T14:05:29.000Z");
    expect(res.body.total_gross_cents).toBe("22500.0000000000");
    expect(res.body.total_net_cents).toBe("22000.0000000000");
    expect(res.body.rows).toEqual([
      { org_id: olive, day: "2026-09-28", gross_cents: "20000.0000000000", net_cents: "20000.0000000000" },
      { org_id: acme, day: "2026-11-17", gross_cents: "2500.0000000000", net_cents: "2500.0000000000" },
      { org_id: acme, day: "2026-11-18", gross_cents: "0.0000000000", net_cents: "-500.0000000000" },
    ]);
  });

  it("502s when stripe-service cannot be read, never zeros", async () => {
    vi.spyOn(ssClient, "getFleetCashByOrgDay").mockRejectedValue(new Error("down"));
    const res = await request(app).get("/internal/cash/by-org-day").set(apiKey);
    expect(res.status).toBe(502);
  });
});
