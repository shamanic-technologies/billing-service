import { Router } from "express";
import { eq, and, isNull, gte, lte, desc, sql as rawSql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import { billingAccounts, transactions } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { DeductRequestSchema, AuthorizeRequestSchema } from "../schemas.js";
import {
  createBalanceTransaction,
  chargePaymentMethod,
  listPaymentIntents,
  isStripeAuthError,
} from "../lib/stripe.js";
import { syncStripeCeilDelta } from "../lib/ledger.js";
import { sendEmail } from "../lib/email-client.js";
import { resolveRequiredCents } from "../lib/costs-client.js";
import { findOrCreateAccount } from "../lib/account.js";
import { traceEvent } from "../lib/trace-event.js";
import { fetchRunsExpectedTotals } from "../lib/runs-client.js";
import { addCents, subCents, gte as gteCents, isDepleted, cmpCents } from "../lib/cents.js";

const router = Router();

/**
 * Compute the reload charge needed to cover `requiredCents` given `currentBalance`.
 * Returns the smallest multiple of `reloadUnit` such that balance + charge >= required.
 * Reload units are integer cents (configured by the user in whole-dollar amounts);
 * required and balance can be fractional.
 */
function computeReloadCharge(currentBalance: string, requiredCents: string, reloadUnit: number): number {
  const deficit = new Decimal(requiredCents).minus(currentBalance);
  if (deficit.lessThanOrEqualTo(0)) return 0;
  const multiples = deficit.dividedBy(reloadUnit).toDecimalPlaces(0, Decimal.ROUND_CEIL).toNumber();
  return multiples * reloadUnit;
}

interface AccountRow {
  id: string;
  org_id: string;
  stripe_customer_id: string | null;
  credit_balance_cents: string;
  reload_amount_cents: number | null;
  reload_threshold_cents: number | null;
  stripe_payment_method_id: string | null;
}

// Namespace keys for advisory locks scoped to billing reconciles (constant int4 each).
// Distinct namespaces per reconcile flavor so a Stripe reconcile lock does not
// block a Runs reconcile (or vice versa) within the same /authorize call.
const RECONCILE_BILLING_STRIPE_LOCK_NAMESPACE = 0x42111331;
const RECONCILE_BILLING_RUNS_LOCK_NAMESPACE = 0x42111332;

/**
 * Reconcile the billing account against its own ledger and Stripe.
 * Runs 3 self-healing checks before authorize checks sufficiency:
 *   1. cache (billing_accounts.credit_balance_cents) vs ledger sum
 *   2. Stripe payment intents missing from the ledger (recover reload rows)
 *   3. Ledger rows confirmed but never synced to Stripe (push to Stripe)
 *
 * Scope: intra-billing + Stripe only. Does NOT reconcile against runs-service —
 * that is `reconcileBillingRuns`.
 *
 * Wrapped in a transaction with `pg_try_advisory_xact_lock` keyed on orgId — concurrent
 * /authorize calls for the same org skip reconcile (the in-flight one will fix any drift).
 * Without the lock, N parallel reconcilers each detect the same drift, insert duplicate
 * ledger rows for the same Stripe PI, and post duplicate balance txns.
 */
async function reconcileBillingStripe(
  orgId: string,
  userId: string,
  wfHeaders: Record<string, string>
): Promise<void> {
  await db.transaction(async (tx) => {
    const lockRows = (await tx.execute(
      rawSql`SELECT pg_try_advisory_xact_lock(${RECONCILE_BILLING_STRIPE_LOCK_NAMESPACE}::int, hashtext(${orgId})) AS locked`
    )) as unknown as { locked: boolean }[];
    if (!lockRows[0]?.locked) {
      return;
    }

    const accountRows = (await tx.execute(
      rawSql`SELECT * FROM billing_accounts WHERE org_id = ${orgId}`
    )) as unknown as AccountRow[];
    const account = accountRows[0];
    if (!account) return;

    // Check 1: Cache vs Ledger
    // Only reconcile if ledger has entries — no entries means account predates ledger
    const ledgerRows = (await tx.execute(
      rawSql`SELECT COALESCE(SUM(
        CASE
          WHEN type = 'credit' AND status = 'confirmed' THEN amount_cents
          WHEN type = 'debit' AND status IN ('confirmed', 'pending') THEN -amount_cents
          ELSE 0
        END
      ), 0)::numeric(16,10)::text AS computed,
      COUNT(*)::int AS entry_count
      FROM transactions WHERE org_id = ${orgId}`
    )) as unknown as { computed: string; entry_count: number }[];
    const { computed, entry_count } = ledgerRows[0];
    if (entry_count > 0 && cmpCents(computed, account.credit_balance_cents) !== 0) {
      console.warn(
        `[billing-service] Cache drift detected for org ${orgId}: cache=${account.credit_balance_cents}, ledger=${computed}. Fixing.`
      );
      await tx
        .update(billingAccounts)
        .set({ creditBalanceCents: computed, updatedAt: new Date() })
        .where(eq(billingAccounts.orgId, orgId));
    }

    // Check 2: Stripe payments -> DB
    if (account.stripe_customer_id) {
      try {
        const paymentIntents = await listPaymentIntents(
          orgId,
          userId,
          account.stripe_customer_id,
          wfHeaders
        );
        for (const pi of paymentIntents.data) {
          if (pi.status !== "succeeded") continue;
          // Idempotent insert: relies on partial unique index
          // (org_id, stripe_payment_intent_id) WHERE source='reload' AND stripe_payment_intent_id IS NOT NULL.
          const insertedRows = (await tx.execute(
            rawSql`INSERT INTO transactions
              (org_id, user_id, type, amount_cents, status, source, stripe_payment_intent_id, description)
              VALUES (${orgId}, ${userId}, 'credit', ${pi.amount}::numeric, 'confirmed', 'reload', ${pi.id},
                ${`Recovered reload from Stripe PI ${pi.id}`})
              ON CONFLICT (org_id, stripe_payment_intent_id)
                WHERE source = 'reload' AND stripe_payment_intent_id IS NOT NULL
              DO NOTHING
              RETURNING id`
          )) as unknown as { id: string }[];
          if (insertedRows.length > 0) {
            console.warn(
              `[billing-service] Missing ledger entry for PI ${pi.id}, org ${orgId}. Recovered.`
            );
            await tx
              .update(billingAccounts)
              .set({
                creditBalanceCents: rawSql`${billingAccounts.creditBalanceCents} + ${pi.amount}::numeric`,
                updatedAt: new Date(),
              })
              .where(eq(billingAccounts.orgId, orgId));
          }
        }
      } catch (err) {
        console.error("[billing-service] Check 2 failed (Stripe -> DB):", err);
      }
    }

    // Check 3: DB -> Stripe (recovery path)
    // Grace filter (2 min): fire-and-forget Stripe sync runs async after the originating
    // request returns; without a grace window we'd race that in-flight call and create
    // duplicate Stripe balance transactions. 7-day upper bound keeps recovery cheap.
    if (account.stripe_customer_id) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
      const unsyncedEntries = await tx
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.orgId, orgId),
            isNull(transactions.stripeBalanceTxnId),
            eq(transactions.status, "confirmed"),
            gte(transactions.createdAt, sevenDaysAgo),
            lte(transactions.createdAt, twoMinAgo)
          )
        );

      for (const entry of unsyncedEntries) {
        try {
          // Recovery sync: send the row's amount rounded up to integer cents.
          // Bound: each recovered fractional row may overshoot Stripe by <1¢.
          // The forward path's ceil-delta strategy (syncStripeCeilDelta) maintains
          // ≤1¢ in steady state; this branch only fires when forward sync failed.
          const ceilAmount = new Decimal(entry.amountCents)
            .toDecimalPlaces(0, Decimal.ROUND_CEIL)
            .toNumber();
          const stripeAmount = entry.type === "credit" ? -ceilAmount : ceilAmount;
          if (stripeAmount === 0) continue;
          const txn = await createBalanceTransaction(
            orgId,
            userId,
            account.stripe_customer_id,
            stripeAmount,
            entry.description ?? `Reconciled ${entry.source}`,
            undefined,
            wfHeaders,
            entry.id
          );
          await tx
            .update(transactions)
            .set({ stripeBalanceTxnId: txn.id, updatedAt: new Date() })
            .where(eq(transactions.id, entry.id));
        } catch (err) {
          console.error(
            `[billing-service] Check 3: Failed to sync ledger entry ${entry.id} to Stripe:`,
            err
          );
        }
      }
    }
  });
}

/**
 * Reconcile the billing ledger against runs-service recorded actuals.
 *
 * Detects per-run drift between:
 *   - billing-side: sum of confirmed `charge` transactions per `run_id`
 *   - runs-side:    sum of `runs_costs.total_cost_in_usd_cents` for platform actuals
 *
 * On gap > 0 (under-billed): inserts a `(debit, charge, confirmed, gap)` row and
 * decrements the balance — catching up revenue that should have been billed.
 * On gap < 0 (over-billed): inserts a `(credit, refund, confirmed, |gap|)` row
 * and increments the balance — refunding the over-charge.
 *
 * Exact, no threshold: even a sub-cent gap is corrected. Idempotent: the newly
 * inserted row contributes to `billed` on the next call so subsequent reconciles
 * compute gap=0 and noop. No state column required.
 *
 * Global gate: org-level totals are compared first (one SUM per side); the
 * per-run sweep only runs when totals diverge. Trade-off: per-run drifts that
 * exactly cancel at the org level go uncorrected (rare — historical drift is
 * one-sided under-billing). The org balance remains correct in that case; only
 * the per-row ledger labels are off.
 *
 * Cross-service call: a single HTTP GET to runs-service. Performed BEFORE the
 * DB transaction opens so we never hold a billing-side row lock across an
 * external network round-trip.
 */
async function reconcileBillingRuns(
  orgId: string,
  userId: string,
  runId: string,
  wfHeaders: Record<string, string>
): Promise<void> {
  let expectedFromRuns: Awaited<ReturnType<typeof fetchRunsExpectedTotals>>;
  try {
    expectedFromRuns = await fetchRunsExpectedTotals(orgId, wfHeaders);
  } catch (err) {
    // Best-effort: do not break /authorize on a transient runs-service outage.
    // Future /authorize will retry; missed reconciles converge on the next run.
    console.error(
      `[billing-service] reconcileBillingRuns: runs-service fetch failed for org ${orgId}:`,
      err
    );
    return;
  }
  if (!expectedFromRuns) return; // runs-service not configured (dev / test)

  const result = await db.transaction(async (tx) => {
    const lockRows = (await tx.execute(
      rawSql`SELECT pg_try_advisory_xact_lock(${RECONCILE_BILLING_RUNS_LOCK_NAMESPACE}::int, hashtext(${orgId})) AS locked`
    )) as unknown as { locked: boolean }[];
    if (!lockRows[0]?.locked) return null;

    const accountRows = (await tx.execute(
      rawSql`SELECT * FROM billing_accounts WHERE org_id = ${orgId} FOR UPDATE`
    )) as unknown as AccountRow[];
    const account = accountRows[0];
    if (!account) return null;

    // Global gate: org-level confirmed charges vs runs-side expected.
    const billedRows = (await tx.execute(
      rawSql`SELECT COALESCE(SUM(amount_cents), 0)::numeric(16,10)::text AS total_billed
             FROM transactions
             WHERE org_id = ${orgId}
               AND source = 'charge'
               AND status = 'confirmed'`
    )) as unknown as { total_billed: string }[];
    const totalBilled = billedRows[0]?.total_billed ?? "0";

    if (cmpCents(expectedFromRuns.total_expected_cents, totalBilled) === 0) {
      return null; // no org-level drift — skip per-run sweep
    }

    // Per-run sweep.
    const collected: {
      entryId: string;
      runId: string;
      oldBalance: string;
      newBalance: string;
      description: string;
      action: "debit" | "refund";
      gap: string;
    }[] = [];
    let currentBalance = account.credit_balance_cents;

    for (const { run_id: targetRunId, expected_cents } of expectedFromRuns.runs) {
      const sumRows = (await tx.execute(
        rawSql`SELECT COALESCE(SUM(amount_cents), 0)::numeric(16,10)::text AS billed
               FROM transactions
               WHERE run_id = ${targetRunId}
                 AND org_id = ${orgId}
                 AND source = 'charge'
                 AND status = 'confirmed'`
      )) as unknown as { billed: string }[];
      const billed = sumRows[0]?.billed ?? "0";

      const gap = subCents(expected_cents, billed);
      const cmp = cmpCents(gap, "0");
      if (cmp === 0) continue;

      const isUnderBilled = cmp > 0;
      const absGap = isUnderBilled ? gap : subCents("0", gap);
      const oldBalance = currentBalance;
      const newBalance = isUnderBilled
        ? subCents(oldBalance, absGap)
        : addCents(oldBalance, absGap);
      const description = isUnderBilled
        ? `Reconcile run ${targetRunId}: under-billed by ${absGap}`
        : `Reconcile run ${targetRunId}: over-billed by ${absGap}`;

      await tx
        .update(billingAccounts)
        .set({ creditBalanceCents: newBalance, updatedAt: new Date() })
        .where(eq(billingAccounts.orgId, orgId));

      const [entry] = await tx
        .insert(transactions)
        .values({
          orgId,
          userId,
          runId: targetRunId,
          type: isUnderBilled ? "debit" : "credit",
          amountCents: absGap,
          status: "confirmed",
          source: isUnderBilled ? "charge" : "refund",
          description,
        })
        .returning();

      currentBalance = newBalance;
      collected.push({
        entryId: entry.id,
        runId: targetRunId,
        oldBalance,
        newBalance,
        description,
        action: isUnderBilled ? "debit" : "refund",
        gap,
      });

      console.warn(
        `[billing-service] reconcileBillingRuns gap ${isUnderBilled ? ">" : "<"} 0`,
        {
          org_id: orgId,
          run_id: targetRunId,
          gap_cents: gap,
          billed_cents: billed,
          expected_cents,
        }
      );
    }

    return { customerId: account.stripe_customer_id, collected };
  });

  if (!result || result.collected.length === 0) return;

  // Post-commit: Stripe ceil-delta sync + trace event for each correction.
  for (const { entryId, oldBalance, newBalance, description } of result.collected) {
    if (result.customerId) {
      syncStripeCeilDelta({
        orgId,
        userId,
        customerId: result.customerId,
        oldBalance,
        newBalance,
        description,
        ledgerEntryId: entryId,
        wfHeaders,
      });
    }
  }

  traceEvent(
    runId,
    {
      service: "billing-service",
      event: "billing.reconcile-run.applied",
      data: {
        fixed_count: result.collected.length,
        entries: result.collected.map((c) => ({
          run_id: c.runId,
          gap_cents: c.gap,
          action: c.action,
        })),
      },
    },
    {
      "x-org-id": orgId,
      "x-user-id": userId,
      ...wfHeaders,
    }
  );
}

// POST /v1/credits/deduct — deduct credits from org balance (allows negative balances)
router.post("/v1/credits/deduct", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const parsed = DeductRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { amount_cents, description } = parsed.data;

    traceEvent(runId, { service: "billing-service", event: "credits.deduct.start", data: { amount_cents } }, req.headers);

    // Ensure account exists (auto-create with $2 trial credit if new)
    await findOrCreateAccount(orgId, userId, wfHeaders);

    // Use Drizzle transaction with FOR UPDATE lock to prevent double-spend
    const result = await db.transaction(async (tx) => {
      const rows = await tx.execute(
        rawSql`SELECT * FROM billing_accounts WHERE org_id = ${orgId} FOR UPDATE`
      );

      const account = (rows as unknown as AccountRow[])[0];
      if (!account) {
        return { error: "Billing account not found" as const, status: 404 as const };
      }

      // Always deduct, even if it results in a negative balance
      const oldBalance = account.credit_balance_cents;
      const newBalance = subCents(oldBalance, amount_cents);
      await tx
        .update(billingAccounts)
        .set({
          creditBalanceCents: newBalance,
          updatedAt: new Date(),
        })
        .where(eq(billingAccounts.orgId, orgId));

      // Insert debit ledger entry
      const [ledgerEntry] = await tx
        .insert(transactions)
        .values({
          orgId,
          userId,
          runId,
          type: "debit",
          amountCents: amount_cents,
          status: "confirmed",
          source: "charge",
          description,
        })
        .returning();

      return {
        success: true as const,
        balance_cents: newBalance,
        depleted: isDepleted(newBalance),
        _oldBalance: oldBalance,
        _customerId: account.stripe_customer_id,
        _ledgerEntryId: ledgerEntry.id,
      };
    });

    if ("error" in result && result.error) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }

    // Fire-and-forget Stripe balance sync — only when ceil-cent boundary crossed
    if (result._customerId && result._ledgerEntryId) {
      syncStripeCeilDelta({
        orgId,
        userId,
        customerId: result._customerId,
        oldBalance: result._oldBalance,
        newBalance: result.balance_cents,
        description,
        ledgerEntryId: result._ledgerEntryId,
        wfHeaders,
      });
    }

    // Send depleted email if needed
    if (result.depleted) {
      sendEmail({
        eventType: "credits-depleted",
        orgId,
        userId,
        runId,
        workflowHeaders: wfHeaders,
      });
    }

    traceEvent(runId, { service: "billing-service", event: "credits.deduct.done", data: { balance_cents: result.balance_cents, depleted: result.depleted } }, req.headers);

    // Strip internal fields from response
    const { _customerId: _c, _ledgerEntryId: _l, _oldBalance: _ob, ...response } = result as Record<string, unknown>;
    res.json(response);
  } catch (err) {
    console.error("[billing-service] Error deducting credits:", err);
    if (isStripeAuthError(err)) {
      res.status(502).json({ error: "Payment provider authentication failed" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /v1/credits/authorize — synchronous pre-execution authorization with auto-reload attempt
// Resolves prices from costs-service, runs reconciliation, then checks balance.
router.post("/v1/credits/authorize", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const parsed = AuthorizeRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { items } = parsed.data;

    traceEvent(runId, { service: "billing-service", event: "credits.authorize.start", data: { item_count: items.length } }, req.headers);

    // Resolve prices from costs-service (outside transaction — read-only, no lock needed)
    let requiredCents: string;
    try {
      requiredCents = await resolveRequiredCents(items, {
        "x-org-id": orgId,
        "x-user-id": userId,
        "x-run-id": runId,
        ...wfHeaders,
      });
    } catch (costErr) {
      traceEvent(runId, { service: "billing-service", event: "credits.authorize.costs-failed", level: "error", detail: String(costErr) }, req.headers);
      console.error("[billing-service] Failed to resolve prices from costs-service:", costErr);
      res.status(502).json({ error: "Failed to resolve prices from costs-service" });
      return;
    }

    traceEvent(runId, { service: "billing-service", event: "credits.authorize.resolved", data: { required_cents: requiredCents } }, req.headers);

    // Ensure account exists (auto-create with $2 trial credit if new)
    await findOrCreateAccount(orgId, userId, wfHeaders);

    // Run reconciliation checks before checking sufficiency. Each acquires its
    // own per-org advisory lock; concurrent /authorize calls for the same org
    // skip and rely on the in-flight reconcile to fix any drift.
    // Order: Stripe-side first (cheap-when-clean, no external dependency cost
    // when ledger is healthy) → runs-side second (depends on runs-service HTTP).
    await reconcileBillingStripe(orgId, userId, wfHeaders);
    await reconcileBillingRuns(orgId, userId, runId, wfHeaders);

    const result = await db.transaction(async (tx) => {
      const rows = await tx.execute(
        rawSql`SELECT * FROM billing_accounts WHERE org_id = ${orgId} FOR UPDATE`
      );

      const account = (rows as unknown as AccountRow[])[0];
      if (!account) {
        return { error: "Billing account not found" as const, status: 404 as const };
      }

      let currentBalance = account.credit_balance_cents;
      const balanceBeforeReload = currentBalance;

      // If insufficient, try synchronous auto-reload (charge enough multiples to cover)
      let reloadLedgerEntryId: string | null = null;
      if (cmpCents(currentBalance, requiredCents) < 0) {
        if (
          account.stripe_payment_method_id &&
          account.stripe_customer_id &&
          account.reload_amount_cents
        ) {
          // Cooldown: skip reload if the last reload entry is cancelled and < 15 min old
          const RELOAD_COOLDOWN_MS = 15 * 60 * 1000;
          const [lastReload] = await tx
            .select({ status: transactions.status, createdAt: transactions.createdAt })
            .from(transactions)
            .where(
              and(
                eq(transactions.orgId, orgId),
                eq(transactions.source, "reload")
              )
            )
            .orderBy(desc(transactions.createdAt))
            .limit(1);

          const reloadOnCooldown =
            lastReload &&
            lastReload.status === "cancelled" &&
            Date.now() - new Date(lastReload.createdAt).getTime() < RELOAD_COOLDOWN_MS;

          if (reloadOnCooldown) {
            console.warn(`[billing-service] Auto-reload skipped for org ${orgId}: cooldown active (last failed reload < 15 min ago)`);
          } else {
            const chargeAmount = computeReloadCharge(currentBalance, requiredCents, account.reload_amount_cents);
            try {
              const pi = await chargePaymentMethod(
                orgId,
                userId,
                account.stripe_customer_id,
                account.stripe_payment_method_id,
                chargeAmount,
                `Auto-reload (${chargeAmount / account.reload_amount_cents}x)`,
                wfHeaders
              );

              // Insert reload ledger entry
              const [reloadEntry] = await tx
                .insert(transactions)
                .values({
                  orgId,
                  userId,
                  type: "credit",
                  amountCents: String(chargeAmount),
                  status: "confirmed",
                  source: "reload",
                  stripePaymentIntentId: pi.id,
                  description: `Auto-reload credit ($${(chargeAmount / 100).toFixed(2)})`,
                })
                .returning();
              reloadLedgerEntryId = reloadEntry.id;

              currentBalance = addCents(currentBalance, String(chargeAmount));
              await tx
                .update(billingAccounts)
                .set({
                  creditBalanceCents: currentBalance,
                  updatedAt: new Date(),
                })
                .where(eq(billingAccounts.orgId, orgId));
            } catch (reloadErr) {
              console.error("[billing-service] Auto-reload failed during authorize:", reloadErr);
              // Record failed reload in ledger for cooldown tracking
              await tx
                .insert(transactions)
                .values({
                  orgId,
                  userId,
                  type: "credit",
                  amountCents: String(computeReloadCharge(currentBalance, requiredCents, account.reload_amount_cents)),
                  status: "cancelled",
                  source: "reload",
                  description: `Auto-reload failed: ${reloadErr instanceof Error ? reloadErr.message : "unknown error"}`,
                });
              return {
                sufficient: false as const,
                balance_cents: currentBalance,
                required_cents: requiredCents,
                _emailEvent: "credits-reload-failed" as const,
                _reloadLedgerEntryId: null as string | null,
                _balanceBefore: balanceBeforeReload,
                _customerId: account.stripe_customer_id,
              };
            }
          }
        }
      }

      const sufficient = gteCents(currentBalance, requiredCents);

      return {
        sufficient: sufficient as boolean,
        balance_cents: currentBalance,
        required_cents: requiredCents,
        _emailEvent: sufficient ? null : ("credits-depleted" as const),
        _reloadLedgerEntryId: reloadLedgerEntryId,
        _balanceBefore: balanceBeforeReload,
        _customerId: account.stripe_customer_id,
      };
    });

    if ("error" in result && result.error) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }

    // Fire-and-forget Stripe balance txn for the reload (if one happened) — uses
    // ceil-delta sized to keep Stripe within ≤1¢ of `ceil(ledger_balance)`.
    if (result._reloadLedgerEntryId && result._customerId) {
      const entry = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, result._reloadLedgerEntryId))
        .limit(1);
      if (entry[0]) {
        syncStripeCeilDelta({
          orgId,
          userId,
          customerId: result._customerId,
          oldBalance: result._balanceBefore,
          newBalance: result.balance_cents,
          description: entry[0].description ?? "Auto-reload credit",
          ledgerEntryId: result._reloadLedgerEntryId,
          wfHeaders,
        });
      }
    }

    // Fire-and-forget email notification
    const emailEvent = "_emailEvent" in result ? result._emailEvent : null;
    if (emailEvent) {
      sendEmail({
        eventType: emailEvent,
        orgId,
        userId,
        runId,
        workflowHeaders: wfHeaders,
      });
    }

    traceEvent(runId, { service: "billing-service", event: "credits.authorize.done", data: { sufficient: result.sufficient, balance_cents: result.balance_cents, required_cents: result.required_cents } }, req.headers);

    // Strip internal fields
    const { _emailEvent, _reloadLedgerEntryId, _balanceBefore, _customerId, ...response } = result as Record<string, unknown>;
    res.json(response);
  } catch (err) {
    console.error("[billing-service] Error authorizing credits:", err);
    if (isStripeAuthError(err)) {
      res.status(502).json({ error: "Payment provider authentication failed" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
