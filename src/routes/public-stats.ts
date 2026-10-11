import { Router } from "express";
import { sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, localPromos } from "../db/schema.js";
import { addCents } from "../lib/cents.js";
import {
  getStats as ssGetStats,
  listOrgPayments,
  type OrgPayment,
  type StripeBillingStatsGrowthRow,
} from "../lib/stripe-service-client.js";
import {
  listAllOffPlatformPayments,
  type FleetOffPlatformPayment,
} from "../lib/off-platform-payments.js";

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
// A ROLLING WINDOW is answered from `first_payment_times`, never from the
// buckets. Those buckets are calendar months and weeks; a rolling window is
// anchored on an INSTANT and aligns to neither, so the bucket straddling its
// edge carries payments on both sides of it — measured against production at 90
// days, whole-bucket summing read 17 where the truth was 25. The array carries
// every account's first settled payment in unix seconds, so a consumer counts
// the entries at or after its own cutoff and gets the exact answer, for any
// window, without this service ever learning which windows exist.
//
// That array is served under TWO names for one release: `first_payment_times_unix`
// (SECONDS, the name a consumer should read) and the DEPRECATED
// `first_payment_times`, byte-identical. The unit belongs in the name because
// `Date.now()` is MILLISECONDS, so `t >= Date.now() - 30 * 86400 * 1000` against a
// seconds array silently counts zero and renders a dash — the exact false alarm
// the array exists to kill. Every money field here already carries its `_cents`.
//
// And its absence is NOT a reason to deny the payload. It is the one figure on
// this route only the staff console's rolling window needs; every money figure
// beside it is computable without it, and failing the whole request for it took
// down the PUBLIC investor metrics page. Absent upstream → both fields are `null`
// plus a loud log. NEVER `[]`: unavailable and "nobody has ever paid" are
// different facts and a consumer that cannot tell them apart renders 0 paid users.
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

/**
 * The first-payment instants stripe-service publishes — UNAVAILABLE is a value,
 * not a failure of this endpoint.
 *
 * Every other figure on this route is a money figure that a consumer arithmetics
 * on, so an unreadable one fails the request. This array is not: exactly one
 * consumer needs it (the staff console's rolling-window payer count), and every
 * other figure here — gross paid, returned, net, credited, local credits, the
 * account counts, the buckets — is perfectly computable without it. Failing the
 * whole payload for its absence took down the PUBLIC investor metrics page, whose
 * landing reader does `if (!billingRes.ok) throw`, for a reason that had nothing
 * to do with it.
 *
 * So an absent array yields `null` and a LOUD log. `null` is the whole point:
 * `[]` would say nobody has ever paid, which is both false and indistinguishable
 * from the truth, and a consumer that cannot tell those apart renders "0 paid
 * users" — the exact false alarm this feature line exists to kill. UNAVAILABLE
 * and EMPTY are different facts and they stay different on the wire.
 *
 * Reads the unit-carrying `first_payment_times_unix` FIRST and falls back to the
 * legacy `first_payment_times`. stripe-service serves both, identical, for one
 * release, so the deploy order of the two services never matters.
 */
function resolveFirstPaymentTimes(stats: {
  first_payment_times_unix?: number[];
  first_payment_times?: number[];
}): number[] | null {
  if (Array.isArray(stats.first_payment_times_unix)) return stats.first_payment_times_unix;
  if (Array.isArray(stats.first_payment_times)) return stats.first_payment_times;
  console.error(
    "[billing-service] stripe-service billing stats carried NEITHER first_payment_times_unix NOR " +
      "first_payment_times — rolling-window payer counts are unavailable this request. Every other " +
      "figure is served as normal; both fields go out as null so a consumer can tell unavailable " +
      "from empty."
  );
  return null;
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

// OFF-PLATFORM PAYMENTS (billing `off_platform_payments`, migration 0082) ARE CASH
// in the platform series too. A bank transfer staff recorded as an off-platform
// payment lives in billing; one recorded as a `direct_payment` lives in
// stripe-service, which already folds it into every figure it publishes. The
// per-org cash read (`cash_paid_cents`) counts both, so the platform series must
// too, or the two disagree about one transfer. Nothing is double counted: an
// off-platform payment is a billing row stripe-service has never seen, and a
// direct payment is a stripe-service row billing never adds.
//
// - MONEY: `revenue_cents` of the bucket holding `paid_at`, `total_revenue_cents`
//   and `total_paid_cents` (gross: it was never refunded). `credited_cents` does
//   NOT move: the grant the payment marks is already in the local promo sum.
// - PAYERS: the org's acquirer + direct history (stripe-service
//   `/internal/payments/by-org`, the same settled predicates the counts use)
//   decides what stripe-service already counted. A bucket holding only the bank
//   transfer gains the org as a payer; an org that never paid any other way
//   becomes a new paying account at its first transfer; an org whose transfer
//   PRECEDES its first acquirer payment has its first-payment instant moved there.
//   One history read per org holding an off-platform payment (1 in prod at ship).

function monthKey(d: Date): string {
  return `${d.toISOString().slice(0, 7)}-01`;
}

function weekKey(d: Date): string {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

interface FoldTarget {
  monthly: BillingGrowthRow[];
  weekly: BillingGrowthRow[];
  totalPaidCents: string;
  totalRevenueCents: string;
  totalPayingAccounts: number;
  firstPaymentTimes: number[] | null;
}

function rowFor(rows: BillingGrowthRow[], period: string): BillingGrowthRow {
  let row = rows.find((r) => r.period === period);
  if (!row) {
    row = {
      period,
      credited_cents: "0.0000000000",
      revenue_cents: "0.0000000000",
      paying_accounts: 0,
      first_time_paying_accounts: 0,
    };
    rows.push(row);
  }
  return row;
}

/** Pure: adds the fleet's off-platform payments to stripe-service's figures. */
export function foldOffPlatformPayments(
  target: FoldTarget,
  payments: FleetOffPlatformPayment[],
  historyByOrg: Map<string, OrgPayment[]>
): FoldTarget {
  const out: FoldTarget = {
    ...target,
    monthly: target.monthly.map((r) => ({ ...r })),
    weekly: target.weekly.map((r) => ({ ...r })),
    firstPaymentTimes: target.firstPaymentTimes ? [...target.firstPaymentTimes] : null,
  };
  const grains: Array<[BillingGrowthRow[], (d: Date) => string]> = [
    [out.monthly, monthKey],
    [out.weekly, weekKey],
  ];

  for (const p of payments) {
    out.totalPaidCents = addCents(out.totalPaidCents, p.amountCents);
    out.totalRevenueCents = addCents(out.totalRevenueCents, p.amountCents);
    for (const [rows, key] of grains) {
      const row = rowFor(rows, key(p.paidAt));
      row.revenue_cents = addCents(row.revenue_cents, p.amountCents);
    }
  }

  const byOrg = new Map<string, Date[]>();
  for (const p of payments) byOrg.set(p.orgId, [...(byOrg.get(p.orgId) ?? []), p.paidAt]);

  for (const [orgId, transfers] of byOrg) {
    const history = historyByOrg.get(orgId);
    if (!history) throw new Error(`no stripe-service payment history read for org ${orgId}`);
    const settled = history
      .filter((h) => h.status === "succeeded")
      .map((h) => new Date(h.created * 1000));
    for (const [rows, key] of grains) {
      const counted = new Set(settled.map(key));
      for (const period of new Set(transfers.map(key))) {
        if (!counted.has(period)) rowFor(rows, period).paying_accounts += 1;
      }
    }
    const firstTransfer = new Date(Math.min(...transfers.map((t) => t.getTime())));
    const firstTransferUnix = Math.floor(firstTransfer.getTime() / 1000);
    if (settled.length === 0) {
      out.totalPayingAccounts += 1;
      for (const [rows, key] of grains) rowFor(rows, key(firstTransfer)).first_time_paying_accounts += 1;
      if (out.firstPaymentTimes) {
        out.firstPaymentTimes.push(firstTransferUnix);
        out.firstPaymentTimes.sort((a, b) => a - b);
      }
      continue;
    }
    const firstSettled = new Date(Math.min(...settled.map((s) => s.getTime())));
    if (firstTransfer.getTime() >= firstSettled.getTime()) continue;
    for (const [rows, key] of grains) {
      rowFor(rows, key(firstSettled)).first_time_paying_accounts -= 1;
      rowFor(rows, key(firstTransfer)).first_time_paying_accounts += 1;
    }
    if (out.firstPaymentTimes) {
      const idx = out.firstPaymentTimes.indexOf(Math.floor(firstSettled.getTime() / 1000));
      if (idx < 0) {
        throw new Error(
          `org ${orgId}: first settled payment ${firstSettled.toISOString()} is not among stripe-service first_payment_times`
        );
      }
      out.firstPaymentTimes[idx] = firstTransferUnix;
      out.firstPaymentTimes.sort((a, b) => a - b);
    }
  }

  out.monthly.sort((a, b) => a.period.localeCompare(b.period));
  out.weekly.sort((a, b) => a.period.localeCompare(b.period));
  return out;
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

    const [monthlyLocal, weeklyLocal, offPlatform] = await Promise.all([
      queryLocalGrowth("month"),
      queryLocalGrowth("week"),
      listAllOffPlatformPayments(),
    ]);

    // One stripe-service history read per org holding an off-platform payment.
    // Unreadable = the payer counts cannot be stated: 502, like every money count here.
    const historyByOrg = new Map<string, OrgPayment[]>();
    try {
      for (const orgId of new Set(offPlatform.map((p) => p.orgId))) {
        historyByOrg.set(orgId, await listOrgPayments(orgId));
      }
    } catch (err) {
      console.error("[billing-service] stripe-service payment history for off-platform orgs failed:", err);
      res.status(502).json({ error: "Failed to fetch stats from stripe-service" });
      return;
    }

    // Resolved BEFORE the try below on purpose: an absent array is not a reason
    // to deny the payload, so it must not travel the 502 path the unreadable
    // money counts take.
    const firstPaymentTimes = resolveFirstPaymentTimes(ssStats);

    let body;
    try {
      const folded = foldOffPlatformPayments(
        {
          monthly: mergeGrowthRows(monthlyLocal, ssStats.monthly_growth, "monthly"),
          weekly: mergeGrowthRows(weeklyLocal, ssStats.weekly_growth, "weekly"),
          totalPaidCents: ssStats.total_paid_cents,
          totalRevenueCents: ssStats.total_net_cents,
          totalPayingAccounts: requirePayingCount(
            ssStats.total_paying_accounts,
            "total_paying_accounts",
            ""
          ),
          firstPaymentTimes,
        },
        offPlatform,
        historyByOrg
      );
      body = {
        total_accounts: accountStats.totalAccounts,
        accounts_with_payment_method: ssStats.accounts_with_payment_method,
        // NET for credited and revenue, GROSS kept as total_paid_cents. See mergeGrowthRows.
        total_credited_cents: addCents(localCreditStats.totalLocalCredits, ssStats.total_net_cents),
        total_paid_cents: folded.totalPaidCents,
        total_revenue_cents: folded.totalRevenueCents,
        total_returned_cents: ssStats.total_returned_cents,
        total_local_credits_cents: localCreditStats.totalLocalCredits,
        total_paying_accounts: folded.totalPayingAccounts,
        // stripe-service's instants, plus ONLY what billing's off-platform
        // payments add (foldOffPlatformPayments). Nothing here filters,
        // truncates or derives a window from it — the consumer picks its own
        // cutoff, which is exactly why the instants are published instead of
        // per-window counts.
        //
        // Served under BOTH names, byte-identical, for one release:
        // `first_payment_times_unix` carries the unit (SECONDS) and is what a
        // consumer should read; `first_payment_times` is DEPRECATED and kept
        // because a live consumer still reads it. `null` on both when
        // stripe-service served neither — never `[]`, which would claim nobody
        // has ever paid.
        first_payment_times_unix: folded.firstPaymentTimes,
        first_payment_times: folded.firstPaymentTimes,
        monthly_growth: folded.monthly,
        weekly_growth: folded.weekly,
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
