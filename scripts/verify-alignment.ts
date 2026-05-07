import postgres from "postgres";
import Stripe from "stripe";

/**
 * 3-way alignment verification across RunService, BillingService, Stripe per org.
 *
 * For each org with a billing_account:
 *   - RunService: sum of runs_costs.actual platform cost for runs that have charges in billing
 *   - BillingService: sum of charge confirmed amount_cents (with run_id), plus pending, plus historical NULL run_id
 *   - BillingService balance: credit_balance_cents column
 *   - BillingService computed balance: SUM(credit confirmed) - SUM(debit confirmed+pending) from ledger
 *   - Stripe customer balance: -ceil(billing balance) expected (Stripe negative = credit)
 */

const BILLING_URL = process.env.BILLING_DATABASE_URL!;
const RUNS_URL = process.env.RUNS_DATABASE_URL!;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY!;
if (!BILLING_URL || !RUNS_URL || !STRIPE_KEY) {
  console.error("[verify] Missing env");
  process.exit(1);
}

const billing = postgres(BILLING_URL, { max: 2, prepare: false });
const runs = postgres(RUNS_URL, { max: 2, prepare: false });
const stripe = new Stripe(STRIPE_KEY, { apiVersion: "2024-11-20.acacia" as any });

interface Account {
  org_id: string;
  stripe_customer_id: string | null;
  ledger_balance: string;
}

interface ChargeAgg {
  charge_confirmed_with_run: string;
  charge_pending: string;
  charge_null_run_confirmed: string;
  credit_confirmed: string;
}

interface RunRealAgg {
  real_platform_actual: string;
}

async function main() {
  const accounts = await billing<Account[]>`
    SELECT org_id::text, stripe_customer_id, credit_balance_cents::text AS ledger_balance
    FROM billing_accounts
    ORDER BY credit_balance_cents DESC
  `;

  console.log("\n3-way alignment verification (cents):\n");
  console.log(
    "org_id".padEnd(38),
    "real_platform".padStart(15),
    "billed_charge".padStart(15),
    "delta_RB".padStart(10),
    "ledger_bal".padStart(14),
    "computed_bal".padStart(14),
    "delta_invar".padStart(11),
    "stripe_bal".padStart(11),
    "stripe_target".padStart(13),
    "delta_S".padStart(8)
  );

  let totalRealPlatform = 0;
  let totalBilledCharge = 0;
  let totalLedgerBal = 0;

  let allOk = true;
  for (const acc of accounts) {
    const [agg] = await billing<ChargeAgg[]>`
      SELECT
        COALESCE(SUM(amount_cents) FILTER (WHERE source='charge' AND status='confirmed' AND run_id IS NOT NULL),0)::text AS charge_confirmed_with_run,
        COALESCE(SUM(amount_cents) FILTER (WHERE source='charge' AND status='pending'),0)::text AS charge_pending,
        COALESCE(SUM(amount_cents) FILTER (WHERE source='charge' AND status='confirmed' AND run_id IS NULL),0)::text AS charge_null_run_confirmed,
        COALESCE(SUM(amount_cents) FILTER (WHERE type='credit' AND status='confirmed'),0)::text AS credit_confirmed
      FROM transactions
      WHERE org_id = ${acc.org_id}
    `;

    const billingRunIds = await billing<{ run_id: string }[]>`
      SELECT DISTINCT run_id::text AS run_id
      FROM transactions
      WHERE org_id = ${acc.org_id} AND source='charge' AND run_id IS NOT NULL
    `;

    let realPlatform = "0";
    if (billingRunIds.length > 0) {
      const ids = billingRunIds.map((r) => r.run_id);
      const CHUNK = 5000;
      let total = 0;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const [row] = await runs<RunRealAgg[]>`
          SELECT
            COALESCE(SUM(rc.total_cost_in_usd_cents::numeric),0)::text AS real_platform_actual
          FROM runs_costs rc
          INNER JOIN runs r ON r.id = rc.run_id
          WHERE r.organization_id = ${acc.org_id}
            AND rc.run_id IN ${runs(slice)}
            AND rc.status = 'actual'
            AND rc.cost_source = 'platform'
        `;
        total += parseFloat(row.real_platform_actual);
      }
      realPlatform = total.toFixed(10);
    }

    const billedChargeNum = parseFloat(agg.charge_confirmed_with_run);
    const realPlatformNum = parseFloat(realPlatform);
    const deltaRB = (billedChargeNum - realPlatformNum).toFixed(10);

    const ledgerBalNum = parseFloat(acc.ledger_balance);
    const creditConfirmed = parseFloat(agg.credit_confirmed);
    const debitTotal =
      parseFloat(agg.charge_confirmed_with_run) +
      parseFloat(agg.charge_pending) +
      parseFloat(agg.charge_null_run_confirmed);
    const computedBal = (creditConfirmed - debitTotal).toFixed(10);
    const deltaInvar = (ledgerBalNum - parseFloat(computedBal)).toFixed(10);

    let stripeBalStr = "n/a";
    let stripeTargetStr = "n/a";
    let deltaSStr = "n/a";
    if (acc.stripe_customer_id) {
      try {
        const cust = await stripe.customers.retrieve(acc.stripe_customer_id);
        if ("balance" in cust) {
          const stripeBal = cust.balance ?? 0;
          const target = -Math.ceil(ledgerBalNum);
          stripeBalStr = String(stripeBal);
          stripeTargetStr = String(target);
          deltaSStr = String(stripeBal - target);
        }
      } catch (err: any) {
        if (err?.statusCode === 404) {
          stripeBalStr = "404";
          stripeTargetStr = "—";
          deltaSStr = "—";
        } else {
          throw err;
        }
      }
    }

    console.log(
      acc.org_id.padEnd(38),
      realPlatform.padStart(15),
      agg.charge_confirmed_with_run.padStart(15),
      deltaRB.padStart(10),
      acc.ledger_balance.padStart(14),
      computedBal.padStart(14),
      deltaInvar.padStart(11),
      stripeBalStr.padStart(11),
      stripeTargetStr.padStart(13),
      deltaSStr.padStart(8)
    );

    totalRealPlatform += realPlatformNum;
    totalBilledCharge += billedChargeNum;
    totalLedgerBal += ledgerBalNum;

    // Tolerance: 0 for invariant, fractional precision allowed for delta_RB (max 1e-6)
    if (Math.abs(parseFloat(deltaInvar)) > 0.00000001) allOk = false;
    if (Math.abs(parseFloat(deltaRB)) > 0.00000001) allOk = false;
    if (deltaSStr !== "n/a" && deltaSStr !== "—" && Math.abs(parseFloat(deltaSStr)) > 0) allOk = false;
  }

  console.log("\nTotals:");
  console.log("  real_platform_actual (RunService): ", totalRealPlatform.toFixed(10));
  console.log("  charge_confirmed_with_run (Billing):", totalBilledCharge.toFixed(10));
  console.log("  ledger_balance sum (Billing):       ", totalLedgerBal.toFixed(10));

  console.log(
    `\n[verify] alignment: ${allOk ? "✅ ALL OK" : "❌ DRIFT DETECTED"}`
  );

  await billing.end();
  await runs.end();
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[verify] FAILED:", err);
  process.exit(2);
});
