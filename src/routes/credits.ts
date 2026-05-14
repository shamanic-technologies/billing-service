import { Router } from "express";
import { eq, and, desc, sql as rawSql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import { billingAccounts, transactions } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { AuthorizeRequestSchema } from "../schemas.js";
import {
  chargePaymentMethod,
  isStripeAuthError,
} from "../lib/stripe.js";
import { sendEmail } from "../lib/email-client.js";
import { resolveRequiredCents } from "../lib/costs-client.js";
import { findOrCreateAccount } from "../lib/account.js";
import { traceEvent } from "../lib/trace-event.js";
import { fetchRunsOrgUsageTotal } from "../lib/runs-client.js";
import { addCents, subCents, gte as gteCents } from "../lib/cents.js";

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

// POST /v1/credits/authorize — synchronous pre-execution authorization with auto-reload attempt
// Resolves prices from costs-service, fetches runs-service usage total, then checks balance.
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

    // Ensure account exists (auto-create with $2 trial credit if new). In the new
    // model this column represents billing-owned credits granted, not usage net.
    const account = await findOrCreateAccount(orgId, userId, wfHeaders);

    let runsUsage;
    try {
      runsUsage = await fetchRunsOrgUsageTotal(orgId, {
        "x-org-id": orgId,
        "x-user-id": userId,
        "x-run-id": runId,
        ...wfHeaders,
      });
    } catch (runsErr) {
      traceEvent(runId, { service: "billing-service", event: "credits.authorize.runs-total-failed", level: "error", detail: String(runsErr) }, req.headers);
      console.error("[billing-service] Failed to fetch usage total from runs-service:", runsErr);
      res.status(502).json({ error: "Failed to fetch usage total from runs-service" });
      return;
    }

    let availableBalance = subCents(account.creditBalanceCents, runsUsage.spent_cents);
    let result: {
      sufficient: boolean;
      balance_cents: string;
      required_cents: string;
      _emailEvent: "credits-depleted" | "credits-reload-failed" | null;
    } = {
      sufficient: gteCents(availableBalance, requiredCents),
      balance_cents: availableBalance,
      required_cents: requiredCents,
      _emailEvent: gteCents(availableBalance, requiredCents) ? null : "credits-depleted",
    };

    if (!result.sufficient) {
      result = await db.transaction(async (tx) => {
        const rows = await tx.execute(
          rawSql`SELECT * FROM billing_accounts WHERE org_id = ${orgId} FOR UPDATE`
        );

        const lockedAccount = (rows as unknown as AccountRow[])[0];
        if (!lockedAccount) {
          return {
            sufficient: false,
            balance_cents: availableBalance,
            required_cents: requiredCents,
            _emailEvent: "credits-depleted" as const,
          };
        }

        availableBalance = subCents(lockedAccount.credit_balance_cents, runsUsage.spent_cents);
        if (gteCents(availableBalance, requiredCents)) {
          return {
            sufficient: true,
            balance_cents: availableBalance,
            required_cents: requiredCents,
            _emailEvent: null,
          };
        }

        if (
          lockedAccount.stripe_payment_method_id &&
          lockedAccount.stripe_customer_id &&
          lockedAccount.reload_amount_cents
        ) {
          // Cooldown: skip reload if the last reload entry is cancelled and < 15 min old.
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
            const chargeAmount = computeReloadCharge(availableBalance, requiredCents, lockedAccount.reload_amount_cents);
            try {
              const pi = await chargePaymentMethod(
                orgId,
                userId,
                lockedAccount.stripe_customer_id,
                lockedAccount.stripe_payment_method_id,
                chargeAmount,
                `Auto-reload (${chargeAmount / lockedAccount.reload_amount_cents}x)`,
                wfHeaders
              );

              await tx
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
                });

              const grantedAfterReload = addCents(lockedAccount.credit_balance_cents, String(chargeAmount));
              await tx
                .update(billingAccounts)
                .set({
                  creditBalanceCents: grantedAfterReload,
                  updatedAt: new Date(),
                })
                .where(eq(billingAccounts.orgId, orgId));

              const balanceAfterReload = subCents(grantedAfterReload, runsUsage.spent_cents);
              return {
                sufficient: gteCents(balanceAfterReload, requiredCents),
                balance_cents: balanceAfterReload,
                required_cents: requiredCents,
                _emailEvent: gteCents(balanceAfterReload, requiredCents) ? null : ("credits-depleted" as const),
              };
            } catch (reloadErr) {
              console.error("[billing-service] Auto-reload failed during authorize:", reloadErr);
              await tx
                .insert(transactions)
                .values({
                  orgId,
                  userId,
                  type: "credit",
                  amountCents: String(computeReloadCharge(availableBalance, requiredCents, lockedAccount.reload_amount_cents)),
                  status: "cancelled",
                  source: "reload",
                  description: `Auto-reload failed: ${reloadErr instanceof Error ? reloadErr.message : "unknown error"}`,
                });
              return {
                sufficient: false,
                balance_cents: availableBalance,
                required_cents: requiredCents,
                _emailEvent: "credits-reload-failed" as const,
              };
            }
          }
        }

        return {
          sufficient: false,
          balance_cents: availableBalance,
          required_cents: requiredCents,
          _emailEvent: "credits-depleted" as const,
        };
      });
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
    const { _emailEvent, ...response } = result as Record<string, unknown>;
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
