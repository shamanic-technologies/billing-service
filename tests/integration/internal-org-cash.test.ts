import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestAccount,
  insertTestPromoGrant,
  closeDb,
} from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

const orgId = "00000000-0000-0000-0000-00000000c451";
const userId = "00000000-0000-0000-0000-00000000c452";
const apiKeyHeaders = { "X-API-Key": "test-api-key" };
const cashPath = (id: string, q = "") => `/internal/accounts/by-org/${id}/cash${q}`;

describe("GET /internal/accounts/by-org/:orgId/cash", () => {
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

  it("an org that never paid: cash 0, its $30 advance is non-cash credit (Aireena)", async () => {
    await insertTestAccount({ orgId, freeCreditOffer: "match_100" });
    await insertTestPromoGrant({ orgId, userId, amountCents: 3000, promoCode: "org_creation_bonus" });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");

    const res = await request(app).get(cashPath(orgId, "?by_month=true")).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.org_id).toBe(orgId);
    expect(res.body.cash_paid_cents).toBe("0.0000000000");
    expect(res.body.credited_cents).toBe("3000.0000000000");
    expect(res.body.non_cash_credit_cents).toBe("3000.0000000000");
    // Every month reads 0 cash.
    for (const m of res.body.cash_by_month) expect(m.cash_paid_cents).toBe("0.0000000000");
  });

  it("a match_100 org that paid $200: cash 20000, the repaid advance is cash, not credit", async () => {
    await insertTestAccount({ orgId, freeCreditOffer: "match_100" });
    await insertTestPromoGrant({ orgId, userId, amountCents: 3000, promoCode: "org_creation_bonus" });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("20000.0000000000");

    const res = await request(app).get(cashPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      org_id: orgId,
      cash_paid_cents: "20000.0000000000",
      credited_cents: "20000.0000000000",
      non_cash_credit_cents: "0.0000000000",
    });
  });

  it("a legacy gift stays non-cash credit beside the cash", async () => {
    await insertTestAccount({ orgId });
    await insertTestPromoGrant({ orgId, userId, amountCents: 500, promoCode: "welcome" });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("5000.0000000000");

    const res = await request(app).get(cashPath(orgId)).set(apiKeyHeaders);

    expect(res.body.cash_paid_cents).toBe("5000.0000000000");
    expect(res.body.non_cash_credit_cents).toBe("500.0000000000");
    expect(res.body.cash_by_month).toBeUndefined();
  });

  it("by_month: net cash per UTC month, a refund lands in its own month, months sum to the total", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    try {
      await insertTestAccount({ orgId, createdAt: new Date("2026-08-20T00:00:00Z") });
      ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("15000.0000000000");
      ssMocks.listOrgPayments.mockResolvedValue([
        { id: "p1", acquirer: "stripe", amount: 10000, currency: "usd", status: "succeeded", created: Date.parse("2026-08-21T00:00:00Z") / 1000 },
      ]);
      // Net as of: Aug 1 = 0, Sep 1 = 10000 (paid in Aug), Oct 1 = 8000 (refund 2000 in Sep).
      const asOf: Record<string, string> = {
        [String(Date.parse("2026-08-01T00:00:00Z") / 1000)]: "0.0000000000",
        [String(Date.parse("2026-09-01T00:00:00Z") / 1000)]: "10000.0000000000",
        [String(Date.parse("2026-10-01T00:00:00Z") / 1000)]: "8000.0000000000",
      };
      ssMocks.sumPaidTopupsForOrgAsOf.mockImplementation(async (_o: string, t: number) => {
        const v = asOf[String(t)];
        if (v === undefined) throw new Error(`unexpected as_of ${t}`);
        return v;
      });

      const res = await request(app).get(cashPath(orgId, "?by_month=true")).set(apiKeyHeaders);

      expect(res.status).toBe(200);
      expect(res.body.cash_by_month).toEqual([
        { month: "2026-08", cash_paid_cents: "10000.0000000000" },
        { month: "2026-09", cash_paid_cents: "-2000.0000000000" },
        { month: "2026-10", cash_paid_cents: "7000.0000000000" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("by_month: cash before the first known month fails loud (502), never a short series", async () => {
    await insertTestAccount({ orgId, createdAt: new Date("2026-08-20T00:00:00Z") });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("5000.0000000000");
    ssMocks.sumPaidTopupsForOrgAsOf.mockResolvedValue("5000.0000000000");

    const res = await request(app).get(cashPath(orgId, "?by_month=true")).set(apiKeyHeaders);

    expect(res.status).toBe(502);
  });

  it("502 when stripe-service cannot be read, never a cash of 0", async () => {
    await insertTestAccount({ orgId });
    ssMocks.sumSucceededTopupsForOrg.mockRejectedValue(new Error("stripe-service down"));

    const res = await request(app).get(cashPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(502);
  });

  it("400 on a bad orgId or by_month", async () => {
    expect((await request(app).get(cashPath("nope")).set(apiKeyHeaders)).status).toBe(400);
    expect((await request(app).get(cashPath(orgId, "?by_month=yes")).set(apiKeyHeaders)).status).toBe(400);
  });
});
