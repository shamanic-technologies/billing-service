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

// One bank transfer, two possible stores: billing `off_platform_payments` or
// stripe-service `direct_payments`. The platform cash series must count it once,
// whichever store holds it (owner 2026-10-11: « LE REVENU ENCAISSE PAR WEEK OU MOIS »).
const olive = "00000000-0000-0000-0000-00000000a11e";
const other = "00000000-0000-0000-0000-00000000b0b0";
const userId = "00000000-0000-0000-0000-00000000a11f";
const apiKey = { "X-API-Key": "test-api-key" };

const SEP_28 = Date.UTC(2026, 8, 28) / 1000;
const OCT_02 = Date.UTC(2026, 9, 2, 11, 30) / 1000;
const AUG_10 = Date.UTC(2026, 7, 10) / 1000;

function ssStats() {
  // stripe-service already holds acquirer payments AND its own direct payments.
  return {
    total_paid_cents: "90000.0000000000",
    total_returned_cents: "0.0000000000",
    total_net_cents: "90000.0000000000",
    accounts_with_payment_method: 1,
    total_paying_accounts: 2,
    first_payment_times: [AUG_10, OCT_02],
    first_payment_times_unix: [AUG_10, OCT_02],
    monthly_growth: [
      { period: "2026-08-01", paid_cents: "20000.0000000000", returned_cents: "0.0000000000", net_cents: "20000.0000000000", paying_accounts: 1, first_time_paying_accounts: 1 },
      { period: "2026-10-01", paid_cents: "70000.0000000000", returned_cents: "0.0000000000", net_cents: "70000.0000000000", paying_accounts: 1, first_time_paying_accounts: 1 },
    ],
    weekly_growth: [
      { period: "2026-08-10", paid_cents: "20000.0000000000", returned_cents: "0.0000000000", net_cents: "20000.0000000000", paying_accounts: 1, first_time_paying_accounts: 1 },
      { period: "2026-09-28", paid_cents: "70000.0000000000", returned_cents: "0.0000000000", net_cents: "70000.0000000000", paying_accounts: 1, first_time_paying_accounts: 1 },
    ],
  };
}

describe("GET /public/stats/billing counts off-platform payments as cash, once", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
    ssMocks.getStats.mockResolvedValue(ssStats() as never);
    ssMocks.listOrgPayments.mockResolvedValue([]);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  async function markOlive(paidAt = "2026-09-28") {
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
      .send({ paidAt, recordedBy: "staff@distribute.you", note: "bank transfer" });
    expect(mark.status).toBe(200);
  }

  // Buckets with revenue only: the grant row itself opens a credited-only bucket at
  // its own creation date (pre-existing behaviour, not cash).
  const revenue = (rows: Array<{ period: string; revenue_cents: string }>) =>
    Object.fromEntries(
      rows.filter((r) => Number(r.revenue_cents) !== 0).map((r) => [r.period, r.revenue_cents])
    );

  it("no off-platform payment: stripe-service figures served unchanged (direct payments counted once, by stripe-service)", async () => {
    const res = await request(app).get("/public/stats/billing");
    expect(res.status).toBe(200);
    expect(res.body.total_revenue_cents).toBe("90000.0000000000");
    expect(revenue(res.body.monthly_growth)).toEqual({
      "2026-08-01": "20000.0000000000",
      "2026-10-01": "70000.0000000000",
    });
    expect(ssMocks.listOrgPayments).not.toHaveBeenCalled();
  });

  it("adds the $200 to Sep 2026 exactly once; no other month moves; Olive becomes a paying account", async () => {
    await markOlive();
    const res = await request(app).get("/public/stats/billing");
    expect(res.status).toBe(200);
    expect(revenue(res.body.monthly_growth)).toEqual({
      "2026-08-01": "20000.0000000000",
      "2026-09-01": "20000.0000000000",
      "2026-10-01": "70000.0000000000",
    });
    // 2026-09-28 is a Monday: same week bucket as the stripe-service one.
    expect(revenue(res.body.weekly_growth)).toEqual({
      "2026-08-10": "20000.0000000000",
      "2026-09-28": "90000.0000000000",
    });
    expect(res.body.total_revenue_cents).toBe("110000.0000000000");
    expect(res.body.total_paid_cents).toBe("110000.0000000000");
    // Credited does not move: the grant is already in the local promo sum.
    expect(res.body.total_credited_cents).toBe("110000.0000000000");
    expect(res.body.total_paying_accounts).toBe(3);
    expect(res.body.first_payment_times_unix).toEqual([AUG_10, SEP_28, OCT_02]);
    const sep = res.body.monthly_growth.find((r: { period: string }) => r.period === "2026-09-01");
    expect(sep.paying_accounts).toBe(1);
    expect(sep.first_time_paying_accounts).toBe(1);
    const week = res.body.weekly_growth.find((r: { period: string }) => r.period === "2026-09-28");
    expect(week.paying_accounts).toBe(2);
    expect(week.first_time_paying_accounts).toBe(2);
  });

  it("an org already paying through an acquirer is not counted twice as a payer", async () => {
    await markOlive();
    ssMocks.listOrgPayments.mockResolvedValue([
      { id: "pi_1", acquirer: "stripe", amount: 20000, currency: "usd", status: "succeeded", created: AUG_10 },
    ] as never);
    ssMocks.getStats.mockResolvedValue({ ...ssStats(), total_paying_accounts: 2 } as never);
    const res = await request(app).get("/public/stats/billing");
    expect(res.status).toBe(200);
    expect(res.body.total_paying_accounts).toBe(2);
    expect(res.body.first_payment_times_unix).toEqual([AUG_10, OCT_02]);
    const sep = res.body.monthly_growth.find((r: { period: string }) => r.period === "2026-09-01");
    expect(sep.paying_accounts).toBe(1);
    expect(sep.first_time_paying_accounts).toBe(0);
  });

  it("a transfer before the org's first acquirer payment moves its first-payment instant", async () => {
    await markOlive();
    ssMocks.listOrgPayments.mockResolvedValue([
      { id: "pi_2", acquirer: "stripe", amount: 70000, currency: "usd", status: "succeeded", created: OCT_02 },
    ] as never);
    const res = await request(app).get("/public/stats/billing");
    expect(res.status).toBe(200);
    expect(res.body.total_paying_accounts).toBe(2);
    expect(res.body.first_payment_times_unix).toEqual([AUG_10, SEP_28]);
    const months = Object.fromEntries(
      res.body.monthly_growth.map((r: { period: string; first_time_paying_accounts: number }) => [r.period, r.first_time_paying_accounts])
    );
    expect(months).toEqual({ "2026-08-01": 1, "2026-09-01": 1, "2026-10-01": 0 });
  });

  it("another org's grant that is NOT marked stays out of the cash series", async () => {
    await insertTestAccount({ orgId: other });
    await insertTestPromoGrant({ orgId: other, userId, amountCents: 5000, promoCode: "admin_grant" });
    const res = await request(app).get("/public/stats/billing");
    expect(res.body.total_revenue_cents).toBe("90000.0000000000");
  });

  it("stripe-service history unreadable → 502, never a guessed payer count", async () => {
    await markOlive();
    ssMocks.listOrgPayments.mockRejectedValue(new Error("down"));
    const res = await request(app).get("/public/stats/billing");
    expect(res.status).toBe(502);
  });
});
