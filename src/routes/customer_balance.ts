import { Router } from "express";
import { eq, and, desc, sql as rawSql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import { billingAccounts, customerBalanceTransactions } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { AuthorizeRequestSchema, UsageApplyRequestSchema } from "../schemas.js";
import {
  chargePaymentMethod,
  isStripeAuthError,
} from "../lib/stripe.js";
import { sendEmail } from "../lib/email-client.js";
import { resolveRequiredCents } from "../lib/costs-client.js";
import { findOrCreateAccount } from "../lib/account.js";
import { traceEvent } from "../lib/trace-event.js";
import { fetchRunsOrgUsageTotal } from "../lib/runs-client.js";
import { addCents, subCents, gte as gteCents, parseNonNegativeCents } from "../lib/cents.js";

const router = Router();

/**
 * Compute the topup charge needed to cover `requiredCents` given `currentAvailable`.
 * Returns the smallest multiple of `topupUnit` such that available + charge >= required.
 * Topup units are integer cents (configured by the user in whole-dollar amounts);
 * required and available can be fractional.
 */
function computeTopupCharge(currentAvailable: string, requiredCents: string, topupUnit: number): number {
  const deficit = new Decimal(requiredCents).minus(currentAvailable);
  if (deficit.lessThanOrEqualTo(0)) return 0;
  const multiples = deficit.dividedBy(topupUnit).toDecimalPlaces(0, Decimal.ROUND_CEIL).toNumber();
  return multiples * topupUnit;
}

interface AccountRow {
  id: string;
  org_id: string;
  stripe_customer_id: string | null;
  balance_cents: string;
  topup_amount_cents: number | null;
  topup_threshold_cents: number | null;
  stripe_payment_method_id: string | null;
}

// POST /v1/customer_balance/authorize — synchronous pre-execution authorization
// with auto-topup attempt. Resolves prices from costs-service, fetches
// runs-service usage total, then checks available = balance − usage.
router.post("/v1/customer_balance/authorize", requireOrgHeaders, async (req, res) => {
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

    traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.start", data: { item_count: items.length } }, req.headers);

    // Resolve prices from costs-service
    let requiredCents: string;
    try {
      requiredCents = await resolveRequiredCents(items, {
        "x-org-id": orgId,
        "x-user-id": userId,
        "x-run-id": runId,
        ...wfHeaders,
      });
    } catch (costErr) {
      traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.costs-failed", level: "error", detail: String(costErr) }, req.headers);
      console.error("[billing-service] Failed to resolve prices from costs-service:", costErr);
      res.status(502).json({ error: "Failed to resolve prices from costs-service" });
      return;
    }

    traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.resolved", data: { required_cents: requiredCents } }, req.headers);

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
      traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.runs-total-failed", level: "error", detail: String(runsErr) }, req.headers);
      console.error("[billing-service] Failed to fetch usage total from runs-service:", runsErr);
      res.status(502).json({ error: "Failed to fetch usage total from runs-service" });
      return;
    }

    let availableCents = subCents(account.balanceCents, runsUsage.spent_cents);
    let result: {
      sufficient: boolean;
      balance_cents: string;
      required_cents: string;
      _emailEvent: "credits-depleted" | "credits-reload-failed" | null;
    } = {
      sufficient: gteCents(availableCents, requiredCents),
      balance_cents: availableCents,
      required_cents: requiredCents,
      _emailEvent: gteCents(availableCents, requiredCents) ? null : "credits-depleted",
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
            balance_cents: availableCents,
            required_cents: requiredCents,
            _emailEvent: "credits-depleted" as const,
          };
        }

        availableCents = subCents(lockedAccount.balance_cents, runsUsage.spent_cents);
        if (gteCents(availableCents, requiredCents)) {
          return {
            sufficient: true,
            balance_cents: availableCents,
            required_cents: requiredCents,
            _emailEvent: null,
          };
        }

        if (
          lockedAccount.stripe_payment_method_id &&
          lockedAccount.stripe_customer_id &&
          lockedAccount.topup_amount_cents
        ) {
          // Cooldown: skip topup if the last payment row is canceled and < 15 min old.
          const TOPUP_COOLDOWN_MS = 15 * 60 * 1000;
          const [lastPayment] = await tx
            .select({ status: customerBalanceTransactions.status, createdAt: customerBalanceTransactions.createdAt })
            .from(customerBalanceTransactions)
            .where(
              and(
                eq(customerBalanceTransactions.orgId, orgId),
                eq(customerBalanceTransactions.type, "payment")
              )
            )
            .orderBy(desc(customerBalanceTransactions.createdAt))
            .limit(1);

          const topupOnCooldown =
            lastPayment &&
            lastPayment.status === "canceled" &&
            Date.now() - new Date(lastPayment.createdAt).getTime() < TOPUP_COOLDOWN_MS;

          if (topupOnCooldown) {
            console.warn(`[billing-service] Auto-topup skipped for org ${orgId}: cooldown active (last failed payment < 15 min ago)`);
          } else {
            const chargeAmount = computeTopupCharge(availableCents, requiredCents, lockedAccount.topup_amount_cents);
            try {
              const pi = await chargePaymentMethod(
                orgId,
                userId,
                lockedAccount.stripe_customer_id,
                lockedAccount.stripe_payment_method_id,
                chargeAmount,
                `Auto-topup (${chargeAmount / lockedAccount.topup_amount_cents}x)`,
                wfHeaders
              );

              await tx
                .insert(customerBalanceTransactions)
                .values({
                  orgId,
                  userId,
                  type: "payment",
                  // Signed: negative = credit. Stripe top-up = credit.
                  amountCents: String(-chargeAmount),
                  status: "succeeded",
                  stripePaymentIntentId: pi.id,
                  description: `Auto-topup ($${(chargeAmount / 100).toFixed(2)})`,
                });

              const balanceAfterTopup = addCents(lockedAccount.balance_cents, String(chargeAmount));
              await tx
                .update(billingAccounts)
                .set({
                  balanceCents: balanceAfterTopup,
                  updatedAt: new Date(),
                })
                .where(eq(billingAccounts.orgId, orgId));

              const availableAfterTopup = subCents(balanceAfterTopup, runsUsage.spent_cents);
              return {
                sufficient: gteCents(availableAfterTopup, requiredCents),
                balance_cents: availableAfterTopup,
                required_cents: requiredCents,
                _emailEvent: gteCents(availableAfterTopup, requiredCents) ? null : ("credits-depleted" as const),
              };
            } catch (topupErr) {
              console.error("[billing-service] Auto-topup failed during authorize:", topupErr);
              await tx
                .insert(customerBalanceTransactions)
                .values({
                  orgId,
                  userId,
                  type: "payment",
                  amountCents: String(-computeTopupCharge(availableCents, requiredCents, lockedAccount.topup_amount_cents)),
                  status: "canceled",
                  description: `Auto-topup failed: ${topupErr instanceof Error ? topupErr.message : "unknown error"}`,
                });
              return {
                sufficient: false,
                balance_cents: availableCents,
                required_cents: requiredCents,
                _emailEvent: "credits-reload-failed" as const,
              };
            }
          }
        }

        return {
          sufficient: false,
          balance_cents: availableCents,
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

    traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.done", data: { sufficient: result.sufficient, balance_cents: result.balance_cents, required_cents: result.required_cents } }, req.headers);

    const { _emailEvent, ...response } = result as Record<string, unknown>;
    res.json(response);
  } catch (err) {
    console.error("[billing-service] Error authorizing customer balance:", err);
    if (isStripeAuthError(err)) {
      res.status(502).json({ error: "Payment provider authentication failed" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /v1/customer_balance/usage_apply — runs-service hint to evaluate
// proactive Stripe topup. Fire-and-forget from caller's perspective: always
// returns 202. Caller correctness does not depend on this; billing re-pulls
// authoritative usage from runs-service at authorize time. Topup triggers when
// available = balance - usage < topup_threshold.
router.post("/v1/customer_balance/usage_apply", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));

    const parsed = UsageApplyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    let spentTotalCents: string;
    try {
      spentTotalCents = parseNonNegativeCents(parsed.data.spent_total_cents);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "invalid spent_total_cents" });
      return;
    }

    traceEvent(runId, { service: "billing-service", event: "customer_balance.usage_apply.start", data: { spent_total_cents: spentTotalCents } }, req.headers);

    const account = await findOrCreateAccount(orgId, userId, wfHeaders);

    const availableCents = subCents(account.balanceCents, spentTotalCents);
    const thresholdCents = account.topupThresholdCents != null ? String(account.topupThresholdCents) : null;
    const topupEligible =
      account.topupAmountCents != null &&
      account.stripePaymentMethodId &&
      account.stripeCustomerId &&
      thresholdCents != null;

    if (!topupEligible || gteCents(availableCents, thresholdCents!)) {
      traceEvent(runId, { service: "billing-service", event: "customer_balance.usage_apply.no-topup", data: { available_cents: availableCents, threshold_cents: thresholdCents } }, req.headers);
      res.status(202).json({ acknowledged: true, topup_triggered: false });
      return;
    }

    const topupTriggered = await db.transaction(async (tx) => {
      const rows = await tx.execute(
        rawSql`SELECT * FROM billing_accounts WHERE org_id = ${orgId} FOR UPDATE`
      );
      const locked = (rows as unknown as AccountRow[])[0];
      if (
        !locked ||
        locked.topup_amount_cents == null ||
        !locked.stripe_payment_method_id ||
        !locked.stripe_customer_id ||
        locked.topup_threshold_cents == null
      ) {
        return false;
      }

      const lockedAvailable = subCents(locked.balance_cents, spentTotalCents);
      const lockedThreshold = String(locked.topup_threshold_cents);
      if (gteCents(lockedAvailable, lockedThreshold)) {
        return false;
      }

      // Cooldown: skip topup if last payment row is canceled and < 15 min old.
      const TOPUP_COOLDOWN_MS = 15 * 60 * 1000;
      const [lastPayment] = await tx
        .select({ status: customerBalanceTransactions.status, createdAt: customerBalanceTransactions.createdAt })
        .from(customerBalanceTransactions)
        .where(and(eq(customerBalanceTransactions.orgId, orgId), eq(customerBalanceTransactions.type, "payment")))
        .orderBy(desc(customerBalanceTransactions.createdAt))
        .limit(1);

      const topupOnCooldown =
        lastPayment &&
        lastPayment.status === "canceled" &&
        Date.now() - new Date(lastPayment.createdAt).getTime() < TOPUP_COOLDOWN_MS;

      if (topupOnCooldown) {
        console.warn(`[billing-service] Notify-triggered topup skipped for org ${orgId}: cooldown active`);
        return false;
      }

      const chargeAmount = computeTopupCharge(lockedAvailable, lockedThreshold, locked.topup_amount_cents);
      if (chargeAmount === 0) return false;

      try {
        const pi = await chargePaymentMethod(
          orgId,
          userId,
          locked.stripe_customer_id,
          locked.stripe_payment_method_id,
          chargeAmount,
          `Auto-topup (${chargeAmount / locked.topup_amount_cents}x, notify-triggered)`,
          wfHeaders
        );

        await tx.insert(customerBalanceTransactions).values({
          orgId,
          userId,
          type: "payment",
          amountCents: String(-chargeAmount),
          status: "succeeded",
          stripePaymentIntentId: pi.id,
          description: `Auto-topup ($${(chargeAmount / 100).toFixed(2)})`,
        });

        await tx
          .update(billingAccounts)
          .set({
            balanceCents: addCents(locked.balance_cents, String(chargeAmount)),
            updatedAt: new Date(),
          })
          .where(eq(billingAccounts.orgId, orgId));

        return true;
      } catch (topupErr) {
        console.error("[billing-service] Notify-triggered topup failed:", topupErr);
        await tx.insert(customerBalanceTransactions).values({
          orgId,
          userId,
          type: "payment",
          amountCents: String(-chargeAmount),
          status: "canceled",
          description: `Auto-topup failed: ${topupErr instanceof Error ? topupErr.message : "unknown error"}`,
        });
        return false;
      }
    });

    if (topupTriggered) {
      traceEvent(runId, { service: "billing-service", event: "customer_balance.usage_apply.topup-fired" }, req.headers);
    } else {
      traceEvent(runId, { service: "billing-service", event: "customer_balance.usage_apply.topup-skipped" }, req.headers);
    }

    res.status(202).json({ acknowledged: true, topup_triggered: topupTriggered });
  } catch (err) {
    console.error("[billing-service] Error in usage_apply:", err);
    if (isStripeAuthError(err)) {
      res.status(502).json({ error: "Payment provider authentication failed" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
