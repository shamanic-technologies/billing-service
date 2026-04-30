import { Router } from "express";
import { sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, creditLedger } from "../db/schema.js";

const router = Router();

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
        rawSql`${creditLedger.type} = 'debit' AND ${creditLedger.status} = 'confirmed'`
      );

    res.json({
      totalAccounts: accountStats.totalAccounts,
      accountsWithPaymentMethod: accountStats.accountsWithPaymentMethod,
      totalCreditBalanceCents: accountStats.totalCreditBalanceCents,
      totalCreditedCents: creditStats.totalCreditedCents,
      totalConsumedCents: debitStats.totalConsumedCents,
    });
  } catch (err) {
    console.error("[billing-service] GET /public/stats/billing failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
