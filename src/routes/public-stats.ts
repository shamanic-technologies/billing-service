import { Router } from "express";
import { sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, localPromos } from "../db/schema.js";
import { addCents } from "../lib/cents.js";
import {
  getStats as ssGetStats,
  type StripeBillingStatsGrowthRow,
} from "../lib/stripe-service-client.js";

const router = Router();

// Public-stats sums are returned as full-precision decimal strings (numeric(16,10)::text).
// Investor/dashboard consumers wanting a display-rounded integer should
// `Math.ceil(parseFloat(...))` at the presentation layer.
//
// HOW MANY ACCOUNTS PAID, and the two things a reader must not assume about it:
//
//   `total_paying_accounts`, plus `paying_accounts` and
//   `first_time_paying_accounts` on every monthly and weekly bucket.
//
//   ACQUIRER COVERAGE IS EVERY ACQUIRER stripe-service takes money through,
//   which is deliberately NOT the scope of `accounts_with_payment_method` right
//   beside them — that one is documented Stripe-only, because it counts saved
//   Stripe cards. Reading the two under one scope is the mistake this exists to
//   fix, so they are stated apart here rather than left to be inferred.
//
//   They count who PAID, never who has a card on file. Those populations differ
//   substantially in production and neither is a subset of the other: a customer
//   paying through a wallet or on the second acquirer holds no Stripe card, and a
//   customer who saved a card has not necessarily been charged.
//
// Taken from stripe-service VERBATIM — this hop forwards, it does not re-derive.
// stripe-service owns money and is the only service that sees every acquirer, so
// a second implementation here would be a second answer. Consequently the
// invariants are stripe-service's own and hold unchanged through this hop:
// `first_time_paying_accounts` summed over all buckets equals
// `total_paying_accounts` on either grain, while `paying_accounts` are distinct
// counts and do not sum to anything.

interface BillingGrowthRow {
  period: string;
  credited_cents: string;
  revenue_cents: string;
  paying_accounts: number;
  first_time_paying_accounts: number;
}

/**
 * A count stripe-service publishes, read fail-loud.
 *
 * A count we could not read is NOT a count of zero: a zero here tells the staff
 * metrics console that nobody paid that week, which is the exact wrong answer
 * and indistinguishable from the truth. A stripe-service too old to publish
 * these (or a reply that lost them) therefore fails the whole endpoint with a
 * 502, the same posture every other money figure on this route takes.
 *
 * Same shape of guard as `netReceivedCents`'s `amount_returned` check: the
 * field is optional on the wire ONLY so an old producer can be detected.
 */
function requirePayingCount(value: number | undefined, field: string, where: string): number {
  if (typeof value !== "number") {
    throw new Error(
      `stripe-service billing stats are missing ${field}${where} — paying-account counts cannot be reported`
    );
  }
  return value;
}

interface LocalGrowthRow {
  period: string;
  credited_cents: string;
}

async function queryLocalGrowth(truncTo: "month" | "week"): Promise<LocalGrowthRow[]> {
  const rows = await db.execute(
    rawSql`SELECT
      to_char(date_trunc(${truncTo}, ${localPromos.createdAt}), 'YYYY-MM-DD') AS period,
      COALESCE(SUM(${localPromos.amountCents}), 0)::numeric(16,10)::text AS credited_cents
    FROM ${localPromos}
    GROUP BY 1
    ORDER BY 1`
  );
  return rows as unknown as LocalGrowthRow[];
}

// Both credited and revenue take the NET Stripe figure (gross minus settled
// refunds and lost disputes). Money we gave back is neither revenue we earned
// nor credit the customer can spend, and `total_revenue_cents` feeds the
// investor metrics page, where overstating by the refunded amount is the wrong
// direction to be wrong in. The raw gross charges stay available, unchanged, as
// `total_paid_cents`. Credited still differs from revenue by the local promo
// grants, exactly as before.
//
// A return is attributed to the period it happened in, not the period of the
// payment it reverses, so a past bucket is never rewritten.
// The paying-account counts ride these same buckets, taken from stripe-service
// VERBATIM — this hop adds no arithmetic to them, exactly as it adds none to
// `net_cents`. A bucket that exists only because a promo was granted in it has
// no stripe-service row, so nobody paid in it: 0 there is a measured fact, not
// a missing value.
function mergeGrowthRows(
  localRows: LocalGrowthRow[],
  ssRows: StripeBillingStatsGrowthRow[],
  grain: string
): BillingGrowthRow[] {
  const merged = new Map<
    string,
    { credited: string; revenue: string; paying: number; firstTime: number }
  >();
  for (const r of localRows) {
    merged.set(r.period, {
      credited: r.credited_cents,
      revenue: "0.0000000000",
      paying: 0,
      firstTime: 0,
    });
  }
  for (const r of ssRows) {
    const where = ` for ${grain} period ${r.period}`;
    const paying = requirePayingCount(r.paying_accounts, "paying_accounts", where);
    const firstTime = requirePayingCount(
      r.first_time_paying_accounts,
      "first_time_paying_accounts",
      where
    );
    const existing = merged.get(r.period);
    if (existing) {
      existing.credited = addCents(existing.credited, r.net_cents);
      existing.revenue = addCents(existing.revenue, r.net_cents);
      existing.paying = paying;
      existing.firstTime = firstTime;
    } else {
      merged.set(r.period, {
        credited: r.net_cents,
        revenue: r.net_cents,
        paying,
        firstTime,
      });
    }
  }
  return [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, v]) => ({
      period,
      credited_cents: v.credited,
      revenue_cents: v.revenue,
      paying_accounts: v.paying,
      first_time_paying_accounts: v.firstTime,
    }));
}

// GET /public/stats/billing — composed: stripe-service paid + local promo credits + billing accounts.
router.get("/public/stats/billing", async (_req, res) => {
  try {
    const [accountStats] = await db
      .select({
        totalAccounts: rawSql<number>`COUNT(*)::int`,
      })
      .from(billingAccounts);

    const [localCreditStats] = await db
      .select({
        totalLocalCredits: rawSql<string>`COALESCE(SUM(${localPromos.amountCents}), 0)::numeric(16,10)::text`,
      })
      .from(localPromos);

    let ssStats;
    try {
      ssStats = await ssGetStats();
    } catch (err) {
      console.error("[billing-service] stripe-service getStats failed:", err);
      res.status(502).json({ error: "Failed to fetch stats from stripe-service" });
      return;
    }

    const [monthlyLocal, weeklyLocal] = await Promise.all([
      queryLocalGrowth("month"),
      queryLocalGrowth("week"),
    ]);

    let body;
    try {
      body = {
        total_accounts: accountStats.totalAccounts,
        accounts_with_payment_method: ssStats.accounts_with_payment_method,
        // NET for credited and revenue, GROSS kept as total_paid_cents. See mergeGrowthRows.
        total_credited_cents: addCents(localCreditStats.totalLocalCredits, ssStats.total_net_cents),
        total_paid_cents: ssStats.total_paid_cents,
        total_revenue_cents: ssStats.total_net_cents,
        total_returned_cents: ssStats.total_returned_cents,
        total_local_credits_cents: localCreditStats.totalLocalCredits,
        total_paying_accounts: requirePayingCount(
          ssStats.total_paying_accounts,
          "total_paying_accounts",
          ""
        ),
        monthly_growth: mergeGrowthRows(monthlyLocal, ssStats.monthly_growth, "monthly"),
        weekly_growth: mergeGrowthRows(weeklyLocal, ssStats.weekly_growth, "weekly"),
      };
    } catch (err) {
      // An unreadable count is an upstream-contract failure, same class as
      // stripe-service being unreachable — 502, never a zero.
      console.error("[billing-service] stripe-service billing stats incomplete:", err);
      res.status(502).json({ error: "Failed to fetch stats from stripe-service" });
      return;
    }

    res.json(body);
  } catch (err) {
    console.error("[billing-service] GET /public/stats/billing failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
