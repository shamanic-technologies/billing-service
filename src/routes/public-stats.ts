import { Router } from "express";
import { sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, customerBalanceTransactions } from "../db/schema.js";

const router = Router();

// Public-stats sums are returned as full-precision decimal strings (numeric(16,10)::text).
// Investor/dashboard consumers wanting a display-rounded integer should
// `Math.ceil(parseFloat(...))` at the presentation layer.
//
// Convention: customer_balance_transactions.amount_cents is signed (negative = credit).
// On public stats we negate sums to show positive "credited" / "revenue" numbers.

interface GrowthRow {
  period: string;
  credited_cents: string;
  revenue_cents: string;
}

async function queryGrowth(truncTo: "month" | "week"): Promise<GrowthRow[]> {
  const rows = await db.execute(
    rawSql`SELECT
      to_char(date_trunc(${truncTo}, ${customerBalanceTransactions.createdAt}), 'YYYY-MM-DD') AS period,
      COALESCE(-SUM(${customerBalanceTransactions.amountCents}) FILTER (
        WHERE ${customerBalanceTransactions.amountCents} < 0
          AND ${customerBalanceTransactions.status} = 'succeeded'
      ), 0)::numeric(16,10)::text AS credited_cents,
      COALESCE(-SUM(${customerBalanceTransactions.amountCents}) FILTER (
        WHERE ${customerBalanceTransactions.amountCents} < 0
          AND ${customerBalanceTransactions.status} = 'succeeded'
          AND ${customerBalanceTransactions.type} = 'payment'
      ), 0)::numeric(16,10)::text AS revenue_cents
    FROM ${customerBalanceTransactions}
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
        totalBalanceCents: rawSql<string>`COALESCE(SUM(${billingAccounts.balanceCents}), 0)::numeric(16,10)::text`,
      })
      .from(billingAccounts);

    // Negate signed sum to surface a positive "credited" total.
    const [creditedStats] = await db
      .select({
        totalCreditedCents: rawSql<string>`COALESCE(-SUM(${customerBalanceTransactions.amountCents}), 0)::numeric(16,10)::text`,
      })
      .from(customerBalanceTransactions)
      .where(
        rawSql`${customerBalanceTransactions.amountCents} < 0 AND ${customerBalanceTransactions.status} = 'succeeded'`
      );

    const [monthlyGrowth, weeklyGrowth] = await Promise.all([
      queryGrowth("month"),
      queryGrowth("week"),
    ]);

    res.json({
      total_accounts: accountStats.totalAccounts,
      accounts_with_payment_method: accountStats.accountsWithPaymentMethod,
      total_balance_cents: accountStats.totalBalanceCents,
      total_credited_cents: creditedStats.totalCreditedCents,
      monthly_growth: monthlyGrowth,
      weekly_growth: weeklyGrowth,
    });
  } catch (err) {
    console.error("[billing-service] GET /public/stats/billing failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
