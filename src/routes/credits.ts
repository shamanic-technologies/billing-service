import { Router } from "express";
import { eq, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { DeductRequestSchema, CheckRequestSchema } from "../schemas.js";
import {
  createBalanceTransaction,
  chargePaymentMethod,
  isStripeAuthError,
} from "../lib/stripe.js";
import { sendEmail } from "../lib/email-client.js";

const router = Router();

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

    // Use Drizzle transaction with FOR UPDATE lock to prevent double-spend
    const result = await db.transaction(async (tx) => {
      // Lock the row with FOR UPDATE via raw SQL
      const rows = await tx.execute<{
        id: string;
        org_id: string;
        stripe_customer_id: string | null;
        billing_mode: string;
        credit_balance_cents: number;
        reload_amount_cents: number | null;
        reload_threshold_cents: number | null;
        stripe_payment_method_id: string | null;
      }>(
        rawSql`SELECT * FROM billing_accounts WHERE org_id = ${orgId} FOR UPDATE`
      );

      const account = (rows as unknown as Array<{
        id: string;
        org_id: string;
        stripe_customer_id: string | null;
        billing_mode: string;
        credit_balance_cents: number;
        reload_amount_cents: number | null;
        reload_threshold_cents: number | null;
        stripe_payment_method_id: string | null;
      }>)[0];
      if (!account) {
        return { error: "Billing account not found" as const, status: 404 as const };
      }

      // BYOK mode — no credit checks, always succeeds
      if (account.billing_mode === "byok") {
        return {
          success: true as const,
          balance_cents: null,
          billing_mode: "byok" as const,
          depleted: false as const,
        };
      }

      let currentBalance = account.credit_balance_cents;
      const filter = eq(billingAccounts.orgId, orgId);
      let reloadFailed = false;

      // If insufficient balance, try auto-reload for PAYG
      if (currentBalance < amount_cents) {
        if (
          account.billing_mode === "payg" &&
          account.stripe_payment_method_id &&
          account.stripe_customer_id &&
          account.reload_amount_cents
        ) {
          try {
            await chargePaymentMethod(
              orgId,
              userId,
              account.stripe_customer_id,
              account.stripe_payment_method_id,
              account.reload_amount_cents,
              "Auto-reload",
              wfHeaders
            );

            await createBalanceTransaction(
              orgId,
              userId,
              account.stripe_customer_id,
              -account.reload_amount_cents,
              "Auto-reload credit",
              undefined,
              wfHeaders
            );

            currentBalance += account.reload_amount_cents;
            await tx
              .update(billingAccounts)
              .set({
                creditBalanceCents: currentBalance,
                updatedAt: new Date(),
              })
              .where(filter);
          } catch (reloadErr) {
            console.error("Auto-reload failed:", reloadErr);
            reloadFailed = true;
          }
        }
      }

      // Always deduct, even if it results in a negative balance
      const newBalance = currentBalance - amount_cents;
      await tx
        .update(billingAccounts)
        .set({
          creditBalanceCents: newBalance,
          updatedAt: new Date(),
        })
        .where(filter);

      // Fire Stripe balance transaction async (non-blocking)
      if (account.stripe_customer_id) {
        createBalanceTransaction(
          orgId,
          userId,
          account.stripe_customer_id,
          amount_cents,
          description,
          { user_id: userId },
          wfHeaders
        ).catch((err) => {
          console.error("Stripe balance transaction failed (async):", err);
        });
      }

      // Check if post-deduction balance is below threshold and PAYG — trigger async reload
      const threshold = account.reload_threshold_cents ?? 200;
      if (
        newBalance < threshold &&
        !reloadFailed &&
        account.billing_mode === "payg" &&
        account.stripe_payment_method_id &&
        account.stripe_customer_id &&
        account.reload_amount_cents
      ) {
        const reloadAmount = account.reload_amount_cents;
        const customerId = account.stripe_customer_id;
        const pmId = account.stripe_payment_method_id;

        (async () => {
          try {
            await chargePaymentMethod(orgId, userId, customerId, pmId, reloadAmount, "Auto-reload", wfHeaders);
            await createBalanceTransaction(orgId, userId, customerId, -reloadAmount, "Auto-reload credit", undefined, wfHeaders);
            await db
              .update(billingAccounts)
              .set({
                creditBalanceCents: rawSql`${billingAccounts.creditBalanceCents} + ${reloadAmount}`,
                updatedAt: new Date(),
              })
              .where(eq(billingAccounts.orgId, orgId));
          } catch (err) {
            console.error("Async auto-reload failed:", err);
            sendEmail({
              eventType: "credits-reload-failed",
              orgId,
              userId,
              runId,
              workflowHeaders: wfHeaders,
            });
          }
        })();
      }

      return {
        success: true as const,
        balance_cents: newBalance,
        billing_mode: account.billing_mode as "trial" | "byok" | "payg",
        depleted: newBalance <= 0,
        _reloadFailed: reloadFailed,
      };
    });

    if ("error" in result && result.error) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }

    // Post-transaction emails
    const reloadFailed = "_reloadFailed" in result && result._reloadFailed;
    if (reloadFailed) {
      sendEmail({
        eventType: "credits-reload-failed",
        orgId,
        userId,
        runId,
        workflowHeaders: wfHeaders,
      });
    }
    if (result.depleted) {
      sendEmail({
        eventType: "credits-depleted",
        orgId,
        userId,
        runId,
        workflowHeaders: wfHeaders,
      });
    }

    // Strip internal fields from response
    const { _reloadFailed, ...response } = result as Record<string, unknown>;
    res.json(response);
  } catch (err) {
    console.error("Error deducting credits:", err);
    if (isStripeAuthError(err)) {
      res.status(502).json({ error: "Payment provider authentication failed" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /v1/credits/check — pre-execution balance check (service-to-service)
router.post("/v1/credits/check", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const parsed = CheckRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { required_cents } = parsed.data;

    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    if (!account) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }

    // BYOK — always sufficient, no credit tracking
    if (account.billingMode === "byok") {
      res.json({
        sufficient: true,
        balance_cents: null,
        billing_mode: "byok",
      });
      return;
    }

    const sufficient = account.creditBalanceCents >= required_cents;

    if (!sufficient) {
      sendEmail({
        eventType: "credits-depleted",
        orgId,
        userId,
        runId,
        workflowHeaders: wfHeaders,
      });
    }

    res.json({
      sufficient,
      balance_cents: account.creditBalanceCents,
      billing_mode: account.billingMode,
    });
  } catch (err) {
    console.error("Error checking credits:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
