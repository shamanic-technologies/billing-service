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

describe("GET /public/stats/billing", () => {
  const app = createTestApp();
  const orgA = "00000000-0000-0000-0000-000000000001";
  const orgB = "00000000-0000-0000-0000-000000000002";
  const userId = "00000000-0000-0000-0000-000000000099";
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

  it("returns zeros when no data and no SS stats", async () => {
    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body.total_accounts).toBe(0);
    expect(res.body.accounts_with_payment_method).toBe(0);
    expect(res.body.total_credited_cents).toBe("0.0000000000");
    expect(res.body.total_paid_cents).toBe("0.0000000000");
    expect(res.body.total_revenue_cents).toBe("0.0000000000");
    expect(res.body.total_local_credits_cents).toBe("0.0000000000");
    expect(res.body.total_paying_accounts).toBe(0);
    expect(res.body.monthly_growth).toEqual([]);
    expect(res.body.weekly_growth).toEqual([]);
  });

  it("does not require authentication", async () => {
    const res = await request(app).get("/public/stats/billing");
    expect(res.status).toBe(200);
  });

  it("composes total_credited from SS paid + local promo credits", async () => {
    await insertTestAccount({ orgId: orgA });
    await insertTestAccount({ orgId: orgB });
    await insertTestPromoGrant({ orgId: orgA, userId, amountCents: 500, promoCode: "welcome" });
    await insertTestPromoGrant({ orgId: orgB, userId, amountCents: 500, promoCode: "welcome" });

    ssMocks.getStats.mockResolvedValue({
      total_paid_cents: "15000.0000000000",
      total_returned_cents: "0.0000000000",
      total_net_cents: "15000.0000000000",
      accounts_with_payment_method: 1,
      total_paying_accounts: 3,
      monthly_growth: [],
      weekly_growth: [],
    });

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body.total_accounts).toBe(2);
    expect(res.body.accounts_with_payment_method).toBe(1);
    expect(res.body.total_paid_cents).toBe("15000.0000000000");
    expect(res.body.total_revenue_cents).toBe("15000.0000000000");
    expect(res.body.total_local_credits_cents).toBe("1000.0000000000");
    expect(res.body.total_credited_cents).toBe("16000.0000000000");
  });

  it("merges monthly_growth from SS + local promos by period", async () => {
    await insertTestAccount({ orgId: orgA });
    await insertTestPromoGrant({ orgId: orgA, userId, amountCents: 500, promoCode: "welcome" });

    ssMocks.getStats.mockResolvedValue({
      total_paid_cents: "5000.0000000000",
      total_returned_cents: "0.0000000000",
      total_net_cents: "5000.0000000000",
      accounts_with_payment_method: 1,
      total_paying_accounts: 3,
      monthly_growth: [
        {
          period: "2026-05-01",
          paid_cents: "5000.0000000000",
          net_cents: "5000.0000000000",
          paying_accounts: 2,
          first_time_paying_accounts: 2,
        },
      ],
      weekly_growth: [
        {
          period: "2026-05-11",
          paid_cents: "5000.0000000000",
          net_cents: "5000.0000000000",
          paying_accounts: 2,
          first_time_paying_accounts: 2,
        },
      ],
    });

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body.monthly_growth.length).toBeGreaterThanOrEqual(1);
    for (const row of res.body.monthly_growth) {
      expect(row).toHaveProperty("period");
      expect(row).toHaveProperty("credited_cents");
      expect(row).toHaveProperty("revenue_cents");
    }

    const totalCredited = res.body.monthly_growth.reduce(
      (s: number, r: { credited_cents: string }) => s + parseFloat(r.credited_cents),
      0
    );
    const totalRevenue = res.body.monthly_growth.reduce(
      (s: number, r: { revenue_cents: string }) => s + parseFloat(r.revenue_cents),
      0
    );
    expect(totalCredited).toBe(5500);
    expect(totalRevenue).toBe(5000);
  });

  // Money given back is neither revenue we earned nor credit the customer can
  // spend. Reporting the gross figure would also make this platform-wide total
  // disagree with the sum of the per-org credited figures, which net returns out
  // per PaymentIntent.
  it("reports credited and revenue NET of returns, keeping paid gross", async () => {
    await insertTestAccount({ orgId: orgA });
    await insertTestPromoGrant({ orgId: orgA, userId, amountCents: 500, promoCode: "welcome" });

    ssMocks.getStats.mockResolvedValue({
      total_paid_cents: "15000.0000000000",
      total_returned_cents: "7500.0000000000",
      total_net_cents: "7500.0000000000",
      accounts_with_payment_method: 1,
      total_paying_accounts: 3,
      monthly_growth: [],
      weekly_growth: [],
    });

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body.total_paid_cents).toBe("15000.0000000000");
    expect(res.body.total_returned_cents).toBe("7500.0000000000");
    expect(res.body.total_revenue_cents).toBe("7500.0000000000");
    expect(res.body.total_credited_cents).toBe("8000.0000000000");
  });

  it("nets returns out of the growth buckets too", async () => {
    await insertTestAccount({ orgId: orgA });

    ssMocks.getStats.mockResolvedValue({
      total_paid_cents: "5000.0000000000",
      total_returned_cents: "2000.0000000000",
      total_net_cents: "3000.0000000000",
      accounts_with_payment_method: 1,
      total_paying_accounts: 3,
      monthly_growth: [
        {
          period: "2026-05-01",
          paid_cents: "5000.0000000000",
          net_cents: "3000.0000000000",
          paying_accounts: 1,
          first_time_paying_accounts: 1,
        },
      ],
      weekly_growth: [
        {
          period: "2026-05-11",
          paid_cents: "5000.0000000000",
          net_cents: "3000.0000000000",
          paying_accounts: 1,
          first_time_paying_accounts: 1,
        },
      ],
    });

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    const may = res.body.monthly_growth.find(
      (r: { period: string }) => r.period === "2026-05-01"
    );
    expect(may.revenue_cents).toBe("3000.0000000000");
    expect(may.credited_cents).toBe("3000.0000000000");
  });

  it("returns 502 when stripe-service stats unavailable", async () => {
    ssMocks.getStats.mockRejectedValue(new Error("SS down"));

    const res = await request(app).get("/public/stats/billing");
    expect(res.status).toBe(502);
  });

  // The staff metrics console asks "how many customers started paying us, per
  // week and per month". Nobody published that, so it derived one from saved
  // Stripe cards dated by attachment — a different population (who has a card)
  // measured on a different clock. stripe-service publishes the real answer
  // across every acquirer; this hop carries it through untouched.
  describe("paying-account counts", () => {
    const ssStatsWithCounts = {
      total_paid_cents: "30000.0000000000",
      total_returned_cents: "0.0000000000",
      total_net_cents: "30000.0000000000",
      accounts_with_payment_method: 31,
      total_paying_accounts: 34,
      monthly_growth: [
        {
          period: "2026-08-01",
          paid_cents: "20000.0000000000",
          net_cents: "20000.0000000000",
          paying_accounts: 9,
          first_time_paying_accounts: 22,
        },
        {
          period: "2026-09-01",
          paid_cents: "10000.0000000000",
          net_cents: "10000.0000000000",
          paying_accounts: 7,
          first_time_paying_accounts: 12,
        },
      ],
      weekly_growth: [
        {
          period: "2026-09-01",
          paid_cents: "4000.0000000000",
          net_cents: "4000.0000000000",
          paying_accounts: 5,
          first_time_paying_accounts: 20,
        },
        {
          period: "2026-09-08",
          paid_cents: "6000.0000000000",
          net_cents: "6000.0000000000",
          paying_accounts: 4,
          first_time_paying_accounts: 14,
        },
      ],
    };

    it("carries the all-time total and both per-period counts, on both grains", async () => {
      ssMocks.getStats.mockResolvedValue(ssStatsWithCounts);

      const res = await request(app).get("/public/stats/billing");

      expect(res.status).toBe(200);
      expect(res.body.total_paying_accounts).toBe(34);

      const aug = res.body.monthly_growth.find(
        (r: { period: string }) => r.period === "2026-08-01"
      );
      expect(aug.paying_accounts).toBe(9);
      expect(aug.first_time_paying_accounts).toBe(22);

      const w37 = res.body.weekly_growth.find(
        (r: { period: string }) => r.period === "2026-09-08"
      );
      expect(w37.paying_accounts).toBe(4);
      expect(w37.first_time_paying_accounts).toBe(14);
    });

    // This hop adds no arithmetic. stripe-service owns money and is the only
    // service that sees every acquirer; re-deriving here would be a second
    // answer to a question that already has one.
    it("forwards the counts verbatim, adding no arithmetic", async () => {
      ssMocks.getStats.mockResolvedValue(ssStatsWithCounts);

      const res = await request(app).get("/public/stats/billing");

      for (const grain of ["monthly_growth", "weekly_growth"] as const) {
        const source = ssStatsWithCounts[grain];
        for (const src of source) {
          const out = res.body[grain].find((r: { period: string }) => r.period === src.period);
          expect(out.paying_accounts).toBe(src.paying_accounts);
          expect(out.first_time_paying_accounts).toBe(src.first_time_paying_accounts);
        }
      }
    });

    // stripe-service's own invariant, which survives this hop because nothing
    // here recomputes it: every account is first-time in exactly one period per
    // grain. `paying_accounts` are DISTINCT counts and deliberately do not sum.
    it("keeps first-time counts summing to the all-time total on either grain", async () => {
      ssMocks.getStats.mockResolvedValue(ssStatsWithCounts);

      const res = await request(app).get("/public/stats/billing");

      for (const grain of ["monthly_growth", "weekly_growth"] as const) {
        const sum = res.body[grain].reduce(
          (s: number, r: { first_time_paying_accounts: number }) =>
            s + r.first_time_paying_accounts,
          0
        );
        expect(sum).toBe(res.body.total_paying_accounts);
      }
    });

    // Who paid and who has a card on file are different populations, and
    // neither contains the other — 34 have paid against 31 carrying a Stripe
    // card. A consumer that reads one as the other reproduces the bug this
    // fixes, so the two must not be collapsed here either.
    it("does not conflate paying accounts with accounts holding a Stripe card", async () => {
      ssMocks.getStats.mockResolvedValue(ssStatsWithCounts);

      const res = await request(app).get("/public/stats/billing");

      expect(res.body.total_paying_accounts).toBe(34);
      expect(res.body.accounts_with_payment_method).toBe(31);
    });

    // A bucket that exists only because a promo was granted in it has no
    // stripe-service row, so nobody paid in it. Zero there is measured, not
    // missing — and the money for that bucket is unaffected.
    it("reports zero payers for a period that only carries promo credit", async () => {
      await insertTestAccount({ orgId: orgA });
      await insertTestPromoGrant({ orgId: orgA, userId, amountCents: 500, promoCode: "welcome" });

      ssMocks.getStats.mockResolvedValue({
        total_paid_cents: "0.0000000000",
        total_returned_cents: "0.0000000000",
        total_net_cents: "0.0000000000",
        accounts_with_payment_method: 0,
        total_paying_accounts: 0,
        monthly_growth: [],
        weekly_growth: [],
      });

      const res = await request(app).get("/public/stats/billing");

      expect(res.status).toBe(200);
      expect(res.body.monthly_growth.length).toBeGreaterThanOrEqual(1);
      for (const row of res.body.monthly_growth) {
        expect(row.paying_accounts).toBe(0);
        expect(row.first_time_paying_accounts).toBe(0);
        expect(parseFloat(row.credited_cents)).toBe(500);
      }
    });

    // A count we could not read is not a count of zero. A zero would tell the
    // console nobody paid, which is both wrong and indistinguishable from the
    // truth — so an incomplete reply fails the endpoint instead.
    it("502s rather than reporting zero when the all-time total is absent", async () => {
      const { total_paying_accounts: _omitted, ...withoutTotal } = ssStatsWithCounts;
      ssMocks.getStats.mockResolvedValue(withoutTotal);

      const res = await request(app).get("/public/stats/billing");

      expect(res.status).toBe(502);
    });

    it("502s rather than reporting zero when a bucket is missing its counts", async () => {
      ssMocks.getStats.mockResolvedValue({
        ...ssStatsWithCounts,
        weekly_growth: [
          {
            period: "2026-09-08",
            paid_cents: "6000.0000000000",
            net_cents: "6000.0000000000",
          },
        ],
      });

      const res = await request(app).get("/public/stats/billing");

      expect(res.status).toBe(502);
    });
  });

  // Every field that existed before this shipped is unchanged in name, type and
  // value. The counts are purely additive; a consumer that does not know about
  // them keeps working byte-for-byte.
  it("leaves every pre-existing field untouched", async () => {
    await insertTestAccount({ orgId: orgA });
    await insertTestPromoGrant({ orgId: orgA, userId, amountCents: 500, promoCode: "welcome" });

    ssMocks.getStats.mockResolvedValue({
      total_paid_cents: "15000.0000000000",
      total_returned_cents: "5000.0000000000",
      total_net_cents: "10000.0000000000",
      accounts_with_payment_method: 1,
      total_paying_accounts: 4,
      monthly_growth: [
        {
          period: "2026-05-01",
          paid_cents: "15000.0000000000",
          net_cents: "10000.0000000000",
          paying_accounts: 3,
          first_time_paying_accounts: 4,
        },
      ],
      weekly_growth: [],
    });

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body.total_accounts).toBe(1);
    expect(res.body.accounts_with_payment_method).toBe(1);
    expect(res.body.total_credited_cents).toBe("10500.0000000000");
    expect(res.body.total_paid_cents).toBe("15000.0000000000");
    expect(res.body.total_revenue_cents).toBe("10000.0000000000");
    expect(res.body.total_returned_cents).toBe("5000.0000000000");
    expect(res.body.total_local_credits_cents).toBe("500.0000000000");

    // The promo is granted today, so it lands in its own bucket; the May
    // bucket carries the stripe figures alone, exactly as it did before.
    const may = res.body.monthly_growth.find(
      (r: { period: string }) => r.period === "2026-05-01"
    );
    expect(may.credited_cents).toBe("10000.0000000000");
    expect(may.revenue_cents).toBe("10000.0000000000");
  });
});
