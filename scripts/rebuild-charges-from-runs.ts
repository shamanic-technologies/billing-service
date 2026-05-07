import postgres from "postgres";

/**
 * One-shot data correction: rebuild `transactions` charge rows from
 * runs-service `runs_costs` (real platform cost per run).
 *
 * Math.ceil bug (pre-v0.21.0) over-billed users 5.5x. v0.21.0 sends raw
 * fractional. Existing prod charge rows still wrong. This rebuilds them.
 *
 * Strategy:
 *   - Source of truth = runs-service `runs_costs` where status='actual' AND cost_source='platform'
 *   - For each org: replace all charge confirmed+cancelled rows (with run_id) by
 *     one charge confirmed row per run whose real platform cost > 0.
 *   - Pending charges untouched (active holds; future confirm/cancel uses fractional path).
 *   - reload/welcome/promo/refund untouched.
 *   - NULL run_id charge rows ("Historical adjustment") preserved.
 *   - Balance recomputed from rebuilt ledger.
 *
 * Default = dry-run. Pass `--apply` to write.
 */

const BILLING_URL = process.env.BILLING_DATABASE_URL!;
const RUNS_URL = process.env.RUNS_DATABASE_URL!;
const APPLY = process.argv.includes("--apply");
const ORG_FILTER = process.argv.find((a) => a.startsWith("--org="))?.slice("--org=".length);

if (!BILLING_URL || !RUNS_URL) {
  console.error("[rebuild] Missing BILLING_DATABASE_URL or RUNS_DATABASE_URL env");
  process.exit(1);
}

interface BillingChargeAgg {
  org_id: string;
  n_charges: string;
  n_runs: string;
  billed_confirmed: string | null;
  billed_pending: string | null;
  billed_cancelled: string | null;
}

interface RunRealCost {
  run_id: string;
  real_actual_cents: string; // numeric as string
}

interface RunOwner {
  run_id: string;
  user_id: string;
}

const billing = postgres(BILLING_URL, { max: 4, prepare: false });
const runs = postgres(RUNS_URL, { max: 4, prepare: false });

async function fetchOrgs(): Promise<string[]> {
  if (ORG_FILTER) return [ORG_FILTER];
  const rows = await billing<BillingChargeAgg[]>`
    SELECT DISTINCT org_id
    FROM transactions
    WHERE source = 'charge' AND run_id IS NOT NULL
    ORDER BY org_id
  `;
  return rows.map((r) => r.org_id);
}

async function fetchOrgBillingRunIds(orgId: string): Promise<string[]> {
  const rows = await billing<{ run_id: string }[]>`
    SELECT DISTINCT run_id
    FROM transactions
    WHERE org_id = ${orgId} AND source = 'charge' AND run_id IS NOT NULL
  `;
  return rows.map((r) => r.run_id);
}

async function fetchRealPlatformCosts(
  orgId: string,
  runIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (runIds.length === 0) return map;
  const CHUNK = 5000;
  for (let i = 0; i < runIds.length; i += CHUNK) {
    const chunk = runIds.slice(i, i + CHUNK);
    const rows = await runs<RunRealCost[]>`
      SELECT
        rc.run_id::text AS run_id,
        SUM(rc.total_cost_in_usd_cents::numeric)::text AS real_actual_cents
      FROM runs_costs rc
      INNER JOIN runs r ON r.id = rc.run_id
      WHERE r.organization_id = ${orgId}
        AND rc.run_id IN ${runs(chunk)}
        AND rc.status = 'actual'
        AND rc.cost_source = 'platform'
      GROUP BY rc.run_id
    `;
    for (const row of rows) {
      const cents = row.real_actual_cents ?? "0";
      if (Number(cents) > 0) map.set(row.run_id, cents);
    }
  }
  return map;
}

async function fetchRunOwners(runIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (runIds.length === 0) return map;
  const CHUNK = 5000;
  for (let i = 0; i < runIds.length; i += CHUNK) {
    const chunk = runIds.slice(i, i + CHUNK);
    const rows = await runs<RunOwner[]>`
      SELECT id::text AS run_id, user_id::text AS user_id
      FROM runs
      WHERE id IN ${runs(chunk)}
    `;
    for (const row of rows) {
      if (row.user_id) map.set(row.run_id, row.user_id);
    }
  }
  return map;
}

async function fetchBillingUserIdFallback(orgId: string): Promise<string | null> {
  const rows = await billing<{ user_id: string }[]>`
    SELECT user_id::text AS user_id
    FROM transactions
    WHERE org_id = ${orgId} AND user_id IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0]?.user_id ?? null;
}

interface OrgPlan {
  orgId: string;
  runsToReplace: { runId: string; userId: string; amountCents: string }[];
  runsToZero: string[]; // present in billing, no real platform cost → pure delete
  beforeBalance: string;
  afterBalance: string;
  beforeChargesConfirmed: string;
  afterChargesConfirmed: string;
}

function sumStr(values: string[]): string {
  let total = 0n;
  let scale = 0;
  // Use string-based to preserve precision: use BigInt over scaled integers.
  // All values have <= 10 decimal places per schema scale.
  const SCALE = 10;
  for (const v of values) {
    const [intPart, decPart = ""] = v.split(".");
    const padded = (decPart + "0".repeat(SCALE)).slice(0, SCALE);
    total += BigInt(intPart + padded);
    scale = SCALE;
  }
  const s = total.toString().padStart(scale + 1, "0");
  const intP = s.slice(0, s.length - scale);
  const decP = s.slice(s.length - scale);
  return `${intP}.${decP}`;
}

async function planForOrg(orgId: string): Promise<OrgPlan> {
  const billingRunIds = await fetchOrgBillingRunIds(orgId);
  const realCosts = await fetchRealPlatformCosts(orgId, billingRunIds);
  const ownerMap = await fetchRunOwners(billingRunIds);
  const fallbackUserId = await fetchBillingUserIdFallback(orgId);

  const runsToReplace: OrgPlan["runsToReplace"] = [];
  const runsToZero: string[] = [];
  for (const runId of billingRunIds) {
    const real = realCosts.get(runId);
    if (real) {
      const userId = ownerMap.get(runId) ?? fallbackUserId;
      if (!userId) {
        throw new Error(`[rebuild] No user_id for run ${runId} (org ${orgId})`);
      }
      runsToReplace.push({ runId, userId, amountCents: real });
    } else {
      runsToZero.push(runId);
    }
  }

  const [{ before_balance: beforeBalance }] = await billing<{ before_balance: string }[]>`
    SELECT credit_balance_cents::text AS before_balance
    FROM billing_accounts
    WHERE org_id = ${orgId}
  `;
  const [{ before_confirmed: beforeChargesConfirmed }] = await billing<{ before_confirmed: string }[]>`
    SELECT COALESCE(SUM(amount_cents),0)::text AS before_confirmed
    FROM transactions
    WHERE org_id = ${orgId} AND source = 'charge' AND status = 'confirmed'
  `;

  const [{ pending_sum, credit_sum }] = await billing<{ pending_sum: string; credit_sum: string }[]>`
    SELECT
      COALESCE(SUM(amount_cents) FILTER (WHERE type='debit' AND status='pending'),0)::text AS pending_sum,
      COALESCE(SUM(amount_cents) FILTER (WHERE type='credit' AND status='confirmed'),0)::text AS credit_sum
    FROM transactions
    WHERE org_id = ${orgId}
  `;

  // Also non-charge debits (none in current schema, but be safe)
  const [{ historical_debit_sum }] = await billing<{ historical_debit_sum: string }[]>`
    SELECT
      COALESCE(SUM(amount_cents) FILTER (WHERE type='debit' AND status='confirmed' AND (source <> 'charge' OR run_id IS NULL)),0)::text AS historical_debit_sum
    FROM transactions
    WHERE org_id = ${orgId}
  `;

  const newConfirmedSum = sumStr(runsToReplace.map((r) => r.amountCents));
  // afterBalance = credit_sum - (newConfirmedSum + historical_debit_sum + pending_sum)
  const totalDebits = sumStr([newConfirmedSum, historical_debit_sum, pending_sum]);
  // signed subtraction in numeric text
  const afterBalance = subtractStr(credit_sum, totalDebits);

  return {
    orgId,
    runsToReplace,
    runsToZero,
    beforeBalance,
    afterBalance,
    beforeChargesConfirmed,
    afterChargesConfirmed: newConfirmedSum,
  };
}

function subtractStr(a: string, b: string): string {
  const SCALE = 10;
  const toBig = (v: string) => {
    const sign = v.startsWith("-") ? -1n : 1n;
    const abs = v.replace(/^-/, "");
    const [i, d = ""] = abs.split(".");
    const padded = (d + "0".repeat(SCALE)).slice(0, SCALE);
    return sign * BigInt(i + padded);
  };
  const result = toBig(a) - toBig(b);
  const sign = result < 0n ? "-" : "";
  const abs = result < 0n ? -result : result;
  const s = abs.toString().padStart(SCALE + 1, "0");
  const intP = s.slice(0, s.length - SCALE);
  const decP = s.slice(s.length - SCALE);
  return `${sign}${intP}.${decP}`;
}

async function applyOrg(plan: OrgPlan): Promise<void> {
  await billing.begin(async (tx) => {
    // Delete charge confirmed + cancelled rows with run_id (the over-billed rows)
    await tx`
      DELETE FROM transactions
      WHERE org_id = ${plan.orgId}
        AND source = 'charge'
        AND status IN ('confirmed', 'cancelled')
        AND run_id IS NOT NULL
    `;

    // Insert 1 charge confirmed per run with real platform cost
    if (plan.runsToReplace.length > 0) {
      const values = plan.runsToReplace.map((r) => ({
        org_id: plan.orgId,
        user_id: r.userId,
        run_id: r.runId,
        type: "debit",
        amount_cents: r.amountCents,
        status: "confirmed",
        source: "charge",
        description:
          "Rebuilt from runs-service real platform cost (Math.ceil bug rebuild)",
      }));
      // Insert in chunks to avoid huge single statement
      const CHUNK = 1000;
      for (let i = 0; i < values.length; i += CHUNK) {
        const slice = values.slice(i, i + CHUNK);
        await tx`
          INSERT INTO transactions ${tx(slice, "org_id", "user_id", "run_id", "type", "amount_cents", "status", "source", "description")}
        `;
      }
    }

    // Recompute balance from rebuilt ledger
    await tx`
      UPDATE billing_accounts
      SET credit_balance_cents = (
        SELECT COALESCE(SUM(amount_cents) FILTER (WHERE type='credit' AND status='confirmed'),0)
             - COALESCE(SUM(amount_cents) FILTER (WHERE type='debit' AND status IN ('confirmed','pending')),0)
        FROM transactions
        WHERE org_id = ${plan.orgId}
      ),
      updated_at = NOW()
      WHERE org_id = ${plan.orgId}
    `;
  });
}

async function main() {
  console.log(
    `[rebuild] mode=${APPLY ? "APPLY" : "DRY-RUN"}${ORG_FILTER ? ` org=${ORG_FILTER}` : ""}`
  );
  const orgs = await fetchOrgs();
  console.log(`[rebuild] orgs in scope: ${orgs.length}`);

  const plans: OrgPlan[] = [];
  for (const orgId of orgs) {
    console.log(`[rebuild] planning org ${orgId}…`);
    const plan = await planForOrg(orgId);
    plans.push(plan);
  }

  console.log("\n[rebuild] PLAN SUMMARY");
  console.log(
    "org_id".padEnd(38),
    "n_replace".padStart(10),
    "n_zero".padStart(8),
    "before_conf".padStart(16),
    "after_conf".padStart(16),
    "before_bal".padStart(16),
    "after_bal".padStart(16)
  );
  for (const p of plans) {
    console.log(
      p.orgId.padEnd(38),
      String(p.runsToReplace.length).padStart(10),
      String(p.runsToZero.length).padStart(8),
      p.beforeChargesConfirmed.padStart(16),
      p.afterChargesConfirmed.padStart(16),
      p.beforeBalance.padStart(16),
      p.afterBalance.padStart(16)
    );
  }

  if (!APPLY) {
    console.log("\n[rebuild] dry-run only. Pass --apply to write.");
    await billing.end();
    await runs.end();
    return;
  }

  console.log("\n[rebuild] applying per-org transactions…");
  for (const plan of plans) {
    console.log(`[rebuild] applying org ${plan.orgId}…`);
    await applyOrg(plan);
    console.log(`[rebuild] org ${plan.orgId} done`);
  }

  // Final invariant check
  console.log("\n[rebuild] post-apply invariant check…");
  const violations = await billing<{ org_id: string; account_balance: string; computed_balance: string }[]>`
    SELECT b.org_id::text,
           b.credit_balance_cents::text AS account_balance,
           (
             COALESCE(SUM(t.amount_cents) FILTER (WHERE t.type='credit' AND t.status='confirmed'),0)
             - COALESCE(SUM(t.amount_cents) FILTER (WHERE t.type='debit' AND t.status IN ('confirmed','pending')),0)
           )::text AS computed_balance
    FROM billing_accounts b
    LEFT JOIN transactions t ON t.org_id = b.org_id
    GROUP BY b.org_id, b.credit_balance_cents
    HAVING b.credit_balance_cents <> COALESCE(SUM(
      CASE
        WHEN t.type='credit' AND t.status='confirmed' THEN t.amount_cents
        WHEN t.type='debit' AND t.status IN ('confirmed','pending') THEN -t.amount_cents
        ELSE 0
      END
    ),0)
  `;
  if (violations.length > 0) {
    console.error("[rebuild] INVARIANT VIOLATIONS:", violations);
    process.exit(2);
  }
  console.log("[rebuild] invariant OK — done");

  await billing.end();
  await runs.end();
}

main().catch((err) => {
  console.error("[rebuild] FAILED:", err);
  process.exit(1);
});
