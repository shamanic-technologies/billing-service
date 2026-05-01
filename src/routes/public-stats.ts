import { Router } from "express";
import { sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, creditLedger } from "../db/schema.js";

const router = Router();

interface GrowthRow {
  period: string;
  credited_cents: number;
  consumed_cents: number;
  revenue_cents: number;
}

async function queryGrowth(truncTo: "month" | "week"): Promise<GrowthRow[]> {
  const rows = await db.execute(
    rawSql`SELECT
      to_char(date_trunc(${truncTo}, ${creditLedger.createdAt}), 'YYYY-MM-DD') AS period,
      COALESCE(SUM(${creditLedger.amountCents}) FILTER (
        WHERE ${creditLedger.type} = 'credit' AND ${creditLedger.status} = 'confirmed'
      ), 0)::int AS credited_cents,
      COALESCE(SUM(${creditLedger.amountCents}) FILTER (
        WHERE ${creditLedger.type} = 'debit' AND ${creditLedger.status} IN ('confirmed', 'pending')
      ), 0)::int AS consumed_cents,
      COALESCE(SUM(${creditLedger.amountCents}) FILTER (
        WHERE ${creditLedger.type} = 'credit' AND ${creditLedger.status} = 'confirmed'
          AND ${creditLedger.source} = 'reload'
      ), 0)::int AS revenue_cents
    FROM ${creditLedger}
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
        totalCreditBalanceCents: rawSql<number>`COALESCE(SUM(${billingAccounts.creditBalanceCents}), 0)::int`,
      })
      .from(billingAccounts);

    const [creditStats] = await db
      .select({
        totalCreditedCents: rawSql<number>`COALESCE(SUM(${creditLedger.amountCents}), 0)::int`,
      })
      .from(creditLedger)
      .where(
        rawSql`${creditLedger.type} = 'credit' AND ${creditLedger.status} = 'confirmed'`
      );

    const [debitStats] = await db
      .select({
        totalConsumedCents: rawSql<number>`COALESCE(SUM(${creditLedger.amountCents}), 0)::int`,
      })
      .from(creditLedger)
      .where(
        rawSql`${creditLedger.type} = 'debit' AND ${creditLedger.status} IN ('confirmed', 'pending')`
      );

    const [monthlyGrowth, weeklyGrowth] = await Promise.all([
      queryGrowth("month"),
      queryGrowth("week"),
    ]);

    res.json({
      totalAccounts: accountStats.totalAccounts,
      accountsWithPaymentMethod: accountStats.accountsWithPaymentMethod,
      totalCreditBalanceCents: accountStats.totalCreditBalanceCents,
      totalCreditedCents: creditStats.totalCreditedCents,
      totalConsumedCents: debitStats.totalConsumedCents,
      monthlyGrowth,
      weeklyGrowth,
    });
  } catch (err) {
    console.error("[billing-service] GET /public/stats/billing failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
