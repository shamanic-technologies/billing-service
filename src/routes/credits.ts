import { Router } from "express";
import { eq, and, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, type BillingAccount } from "../db/schema.js";
import { requireOrgHeaders } from "../middleware/auth.js";
import { DeductRequestSchema } from "../schemas.js";
import {
  createBalanceTransaction,
  chargePaymentMethod,
} from "../lib/stripe.js";

const router = Router();

// POST /v1/credits/deduct — deduct credits from org balance
router.post("/v1/credits/deduct", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const appId = req.headers["x-app-id"] as string;
    const parsed = DeductRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { amount_cents, description, app_id, user_id } = parsed.data;

    // Use Drizzle transaction with FOR UPDATE lock to prevent double-spend
    const result = await db.transaction(async (tx) => {
      // Lock the row with FOR UPDATE via raw SQL
      const rows = await tx.execute<{
        id: string;
        org_id: string;
        app_id: string;
        stripe_customer_id: string | null;
        billing_mode: string;
        credit_balance_cents: number;
        reload_amount_cents: number | null;
        reload_threshold_cents: number | null;
        stripe_payment_method_id: string | null;
      }>(
        rawSql`SELECT * FROM billing_accounts WHERE org_id = ${orgId} AND app_id = ${appId} FOR UPDATE`
      );

      const account = (rows as unknown as Array<{
        id: string;
        org_id: string;
        app_id: string;
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
      const filter = and(eq(billingAccounts.orgId, orgId), eq(billingAccounts.appId, appId));

      // If insufficient balance, try auto-reload for PAYG
      if (currentBalance < amount_cents) {
        if (
          account.billing_mode === "payg" &&
          account.stripe_payment_method_id &&
          account.stripe_customer_id &&
          account.reload_amount_cents
        ) {
          try {
            // Charge the saved payment method
            await chargePaymentMethod(
              appId,
              account.stripe_customer_id,
              account.stripe_payment_method_id,
              account.reload_amount_cents,
              "Auto-reload"
            );

            // Credit the Stripe balance
            await createBalanceTransaction(
              appId,
              account.stripe_customer_id,
              -account.reload_amount_cents,
              "Auto-reload credit"
            );

            // Update local cache
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
            return {
              success: false as const,
              balance_cents: currentBalance,
              billing_mode: account.billing_mode as "trial" | "byok" | "payg",
              depleted: true as const,
            };
          }
        }

        // Still insufficient after potential reload
        if (currentBalance < amount_cents) {
          return {
            success: false as const,
            balance_cents: currentBalance,
            billing_mode: account.billing_mode as "trial" | "byok" | "payg",
            depleted: true as const,
          };
        }
      }

      // Deduct from DB
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
          appId,
          account.stripe_customer_id,
          amount_cents, // positive = deduction in Stripe
          description,
          { app_id, user_id }
        ).catch((err) => {
          console.error("Stripe balance transaction failed (async):", err);
        });
      }

      // Check if post-deduction balance is below threshold and PAYG — trigger reload
      const threshold = account.reload_threshold_cents ?? 200;
      if (
        newBalance < threshold &&
        account.billing_mode === "payg" &&
        account.stripe_payment_method_id &&
        account.stripe_customer_id &&
        account.reload_amount_cents
      ) {
        const reloadAmount = account.reload_amount_cents;
        const customerId = account.stripe_customer_id;
        const pmId = account.stripe_payment_method_id;

        // Fire auto-reload async (non-blocking)
        (async () => {
          try {
            await chargePaymentMethod(appId, customerId, pmId, reloadAmount, "Auto-reload");
            await createBalanceTransaction(appId, customerId, -reloadAmount, "Auto-reload credit");
            await db
              .update(billingAccounts)
              .set({
                creditBalanceCents: rawSql`${billingAccounts.creditBalanceCents} + ${reloadAmount}`,
                updatedAt: new Date(),
              })
              .where(and(eq(billingAccounts.orgId, orgId), eq(billingAccounts.appId, appId)));
          } catch (err) {
            console.error("Async auto-reload failed:", err);
          }
        })();
      }

      return {
        success: true as const,
        balance_cents: newBalance,
        billing_mode: account.billing_mode as "trial" | "byok" | "payg",
        depleted: false as const,
      };
    });

    if ("error" in result && result.error) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }

    res.json(result);
  } catch (err) {
    console.error("Error deducting credits:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
