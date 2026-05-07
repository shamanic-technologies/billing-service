import postgres from "postgres";
import Stripe from "stripe";

/**
 * Stripe customer balance resync after Math.ceil rebuild.
 *
 * For each billing_account with a stripe_customer_id:
 *   - Read current Stripe customer balance.
 *   - Target = -ceil(parseFloat(credit_balance_cents)) (Stripe negative = customer credit).
 *   - If delta != 0: createBalanceTransaction(delta) with idempotency key.
 *
 * Default = dry-run. Pass --apply to write.
 */

const BILLING_URL = process.env.BILLING_DATABASE_URL!;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY!;
const APPLY = process.argv.includes("--apply");

if (!BILLING_URL || !STRIPE_KEY) {
  console.error("[stripe-resync] Missing BILLING_DATABASE_URL or STRIPE_SECRET_KEY env");
  process.exit(1);
}

const billing = postgres(BILLING_URL, { max: 2, prepare: false });
const stripe = new Stripe(STRIPE_KEY, { apiVersion: "2024-11-20.acacia" as any });

interface AccountRow {
  org_id: string;
  stripe_customer_id: string;
  ledger_balance: string;
}

async function fetchAccounts(): Promise<AccountRow[]> {
  return billing<AccountRow[]>`
    SELECT org_id::text, stripe_customer_id, credit_balance_cents::text AS ledger_balance
    FROM billing_accounts
    WHERE stripe_customer_id IS NOT NULL
    ORDER BY credit_balance_cents DESC
  `;
}

interface ResyncRow {
  orgId: string;
  customerId: string;
  ledgerBalance: string;
  ledgerCeilCents: number;
  targetStripeBalance: number;
  currentStripeBalance: number;
  delta: number;
}

async function plan(): Promise<ResyncRow[]> {
  const accounts = await fetchAccounts();
  const rows: ResyncRow[] = [];
  for (const acc of accounts) {
    const ledgerNum = parseFloat(acc.ledger_balance);
    const ledgerCeilCents = Math.ceil(ledgerNum);
    const targetStripeBalance = -ledgerCeilCents;
    let currentStripeBalance: number;
    try {
      const customer = await stripe.customers.retrieve(acc.stripe_customer_id);
      if (customer.deleted) {
        console.warn(`[stripe-resync] customer ${acc.stripe_customer_id} deleted, skipping`);
        continue;
      }
      currentStripeBalance = customer.balance ?? 0;
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.code === "resource_missing") {
        console.warn(`[stripe-resync] customer ${acc.stripe_customer_id} (org ${acc.org_id}) not found in Stripe live, skipping`);
        continue;
      }
      throw err;
    }
    const delta = targetStripeBalance - currentStripeBalance;
    rows.push({
      orgId: acc.org_id,
      customerId: acc.stripe_customer_id,
      ledgerBalance: acc.ledger_balance,
      ledgerCeilCents,
      targetStripeBalance,
      currentStripeBalance,
      delta,
    });
  }
  return rows;
}

async function applyDelta(row: ResyncRow): Promise<void> {
  if (row.delta === 0) return;
  const idempotencyKey = `rebuild-2026-05-07-${row.orgId}`;
  await stripe.customers.createBalanceTransaction(
    row.customerId,
    {
      amount: row.delta,
      currency: "usd",
      description: "Rebuild from runs-service truth (Math.ceil bug correction)",
      metadata: {
        org_id: row.orgId,
        kind: "rebuild_2026_05_07",
      },
    },
    { idempotencyKey }
  );
}

async function main() {
  console.log(`[stripe-resync] mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const rows = await plan();
  console.log(
    "\norg_id".padEnd(38),
    "customer".padEnd(20),
    "ledger".padStart(16),
    "ledgerCeil".padStart(12),
    "targetStripe".padStart(14),
    "currentStripe".padStart(14),
    "delta".padStart(10)
  );
  for (const r of rows) {
    console.log(
      r.orgId.padEnd(38),
      r.customerId.padEnd(20),
      r.ledgerBalance.padStart(16),
      String(r.ledgerCeilCents).padStart(12),
      String(r.targetStripeBalance).padStart(14),
      String(r.currentStripeBalance).padStart(14),
      String(r.delta).padStart(10)
    );
  }

  const nonZero = rows.filter((r) => r.delta !== 0);
  console.log(`\n[stripe-resync] ${nonZero.length}/${rows.length} need resync`);

  if (!APPLY) {
    await billing.end();
    return;
  }

  for (const row of nonZero) {
    console.log(`[stripe-resync] applying delta=${row.delta} for org ${row.orgId}…`);
    await applyDelta(row);
  }
  console.log("[stripe-resync] done");
  await billing.end();
}

main().catch((err) => {
  console.error("[stripe-resync] FAILED:", err);
  process.exit(1);
});
