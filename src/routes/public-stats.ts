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

interface BillingGrowthRow {
  period: string;
  credited_cents: string;
  revenue_cents: string;
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

function mergeGrowthRows(
  localRows: LocalGrowthRow[],
  ssRows: StripeBillingStatsGrowthRow[]
): BillingGrowthRow[] {
  const merged = new Map<string, { credited: string; revenue: string }>();
  for (const r of localRows) {
    merged.set(r.period, { credited: r.credited_cents, revenue: "0.0000000000" });
  }
  for (const r of ssRows) {
    const existing = merged.get(r.period);
    if (existing) {
      existing.credited = addCents(existing.credited, r.paid_cents);
      existing.revenue = addCents(existing.revenue, r.paid_cents);
    } else {
      merged.set(r.period, { credited: r.paid_cents, revenue: r.paid_cents });
    }
  }
  return [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, v]) => ({
      period,
      credited_cents: v.credited,
      revenue_cents: v.revenue,
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
      ssStats = await ssGetStats({
        "x-org-id": "00000000-0000-0000-0000-000000000000",
        "x-user-id": "00000000-0000-0000-0000-000000000000",
      });
    } catch (err) {
      console.error("[billing-service] stripe-service getStats failed:", err);
      res.status(502).json({ error: "Failed to fetch stats from stripe-service" });
      return;
    }

    const [monthlyLocal, weeklyLocal] = await Promise.all([
      queryLocalGrowth("month"),
      queryLocalGrowth("week"),
    ]);

    res.json({
      total_accounts: accountStats.totalAccounts,
      accounts_with_payment_method: ssStats.accounts_with_payment_method,
      total_credited_cents: addCents(localCreditStats.totalLocalCredits, ssStats.total_paid_cents),
      total_paid_cents: ssStats.total_paid_cents,
      total_local_credits_cents: localCreditStats.totalLocalCredits,
      monthly_growth: mergeGrowthRows(monthlyLocal, ssStats.monthly_growth),
      weekly_growth: mergeGrowthRows(weeklyLocal, ssStats.weekly_growth),
    });
  } catch (err) {
    console.error("[billing-service] GET /public/stats/billing failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
