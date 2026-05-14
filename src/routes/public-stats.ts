import { Router } from "express";
import { sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, transactions } from "../db/schema.js";

const router = Router();

// Public-stats sums are returned as full-precision decimal strings (numeric(16,10)::text).
// Investor/dashboard consumers wanting a display-rounded integer should
// `Math.ceil(parseFloat(...))` at the presentation layer.

interface GrowthRow {
  period: string;
  credited_cents: string;
  revenue_cents: string;
}

async function queryGrowth(truncTo: "month" | "week"): Promise<GrowthRow[]> {
  const rows = await db.execute(
    rawSql`SELECT
      to_char(date_trunc(${truncTo}, ${transactions.createdAt}), 'YYYY-MM-DD') AS period,
      COALESCE(SUM(${transactions.amountCents}) FILTER (
        WHERE ${transactions.type} = 'credit' AND ${transactions.status} = 'confirmed'
      ), 0)::numeric(16,10)::text AS credited_cents,
      COALESCE(SUM(${transactions.amountCents}) FILTER (
        WHERE ${transactions.type} = 'credit' AND ${transactions.status} = 'confirmed'
          AND ${transactions.source} = 'reload'
      ), 0)::numeric(16,10)::text AS revenue_cents
    FROM ${transactions}
    GROUP BY 1
    ORDER BY 1`
  );
  return rows as unknown as GrowthRow[];
}

router.get("/public/stats/billing", async (_req, res) => {
  try {
    const [accountStats] = await db
      .select({
        totalAccounts: rawSql<number>`COUNT(*)::int`,
        accountsWithPaymentMethod: rawSql<number>`COUNT(*) FILTER (WHERE ${billingAccounts.stripePaymentMethodId} IS NOT NULL)::int`,
        totalGrantsCents: rawSql<string>`COALESCE(SUM(${billingAccounts.creditBalanceCents}), 0)::numeric(16,10)::text`,
      })
      .from(billingAccounts);

    const [creditStats] = await db
      .select({
        totalCreditedCents: rawSql<string>`COALESCE(SUM(${transactions.amountCents}), 0)::numeric(16,10)::text`,
      })
      .from(transactions)
      .where(
        rawSql`${transactions.type} = 'credit' AND ${transactions.status} = 'confirmed'`
      );

    const [monthlyGrowth, weeklyGrowth] = await Promise.all([
      queryGrowth("month"),
      queryGrowth("week"),
    ]);

    res.json({
      totalAccounts: accountStats.totalAccounts,
      accountsWithPaymentMethod: accountStats.accountsWithPaymentMethod,
      totalGrantsCents: accountStats.totalGrantsCents,
      totalCreditedCents: creditStats.totalCreditedCents,
      monthlyGrowth,
      weeklyGrowth,
    });
  } catch (err) {
    console.error("[billing-service] GET /public/stats/billing failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
