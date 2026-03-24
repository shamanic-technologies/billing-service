import { Router } from "express";
import { eq, sql as rawSql, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, creditProvisions } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { ProvisionRequestSchema, ConfirmProvisionRequestSchema } from "../schemas.js";
import {
  createBalanceTransaction,
  chargePaymentMethod,
  isStripeAuthError,
} from "../lib/stripe.js";
import { sendEmail } from "../lib/email-client.js";
import { findOrCreateAccount } from "../lib/account.js";

const router = Router();

// POST /v1/credits/provision — provision credits (deduct from balance immediately)
router.post("/v1/credits/provision", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = getWorkflowHeaders(req);
    const fwdHeaders = forwardWorkflowHeaders(wfHeaders);
    const parsed = ProvisionRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { amount_cents, description } = parsed.data;

    // Ensure account exists (auto-create with $2 trial credit if new)
    await findOrCreateAccount(orgId, userId, fwdHeaders);

    const result = await db.transaction(async (tx) => {
      const rows = await tx.execute<{
        id: string;
        org_id: string;
        stripe_customer_id: string | null;
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
        credit_balance_cents: number;
        reload_amount_cents: number | null;
        reload_threshold_cents: number | null;
        stripe_payment_method_id: string | null;
      }>)[0];

      if (!account) {
        return { error: "Billing account not found" as const, status: 404 as const };
      }

      // Deduct from balance (allow negative)
      const newBalance = account.credit_balance_cents - amount_cents;
      await tx
        .update(billingAccounts)
        .set({
          creditBalanceCents: newBalance,
          updatedAt: new Date(),
        })
        .where(eq(billingAccounts.orgId, orgId));

      const [provision] = await tx
        .insert(creditProvisions)
        .values({
          orgId,
          userId,
          runId,
          amountCents: amount_cents,
          status: "pending",
          description,
          campaignId: wfHeaders.campaignId,
          brandId: wfHeaders.brandId,
          workflowName: wfHeaders.workflowName,
          featureSlug: wfHeaders.featureSlug,
        })
        .returning();

      return {
        provision_id: provision.id,
        balance_cents: newBalance,
        depleted: newBalance <= 0,
        _account: account,
      };
    });

    if ("error" in result && result.error) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }

    // Post-transaction: async auto-reload if below threshold (PAYG)
    if ("_account" in result && result._account) {
      const account = result._account;
      const threshold = account.reload_threshold_cents ?? 200;
      if (
        result.balance_cents !== null &&
        result.balance_cents < threshold &&
        account.stripe_payment_method_id &&
        account.stripe_customer_id &&
        account.reload_amount_cents
      ) {
        const reloadAmount = account.reload_amount_cents;
        const customerId = account.stripe_customer_id;
        const pmId = account.stripe_payment_method_id;

        (async () => {
          try {
            await chargePaymentMethod(orgId, userId, customerId, pmId, reloadAmount, "Auto-reload", fwdHeaders);
            await createBalanceTransaction(orgId, userId, customerId, -reloadAmount, "Auto-reload credit", undefined, fwdHeaders);
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
              workflowHeaders: fwdHeaders,
            });
          }
        })();
      }

      // Send depleted email if needed
      if (result.depleted) {
        sendEmail({
          eventType: "credits-depleted",
          orgId,
          userId,
          runId,
          workflowHeaders: fwdHeaders,
        });
      }
    }

    // Strip internal _account from response
    const { _account, ...response } = result as Record<string, unknown>;
    res.json(response);
  } catch (err) {
    console.error("Error creating provision:", err);
    if (isStripeAuthError(err)) {
      res.status(502).json({ error: "Payment provider authentication failed" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /v1/credits/provision/:id/confirm — confirm provision, optionally adjust for actual cost
router.post("/v1/credits/provision/:id/confirm", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const provisionId = req.params.id;
    const parsed = ConfirmProvisionRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { actual_amount_cents } = parsed.data;

    const result = await db.transaction(async (tx) => {
      // Lock the provision row
      const provRows = await tx.execute<{
        id: string;
        org_id: string;
        amount_cents: number;
        status: string;
      }>(
        rawSql`SELECT * FROM credit_provisions WHERE id = ${provisionId} AND org_id = ${orgId} FOR UPDATE`
      );

      const provision = (provRows as unknown as Array<{
        id: string;
        org_id: string;
        amount_cents: number;
        status: string;
      }>)[0];

      if (!provision) {
        return { error: "Provision not found" as const, status: 404 as const };
      }

      if (provision.status !== "pending") {
        return { error: `Provision already ${provision.status}` as const, status: 409 as const };
      }

      // If actual cost differs, adjust balance
      const adjustmentCents = actual_amount_cents !== undefined
        ? provision.amount_cents - actual_amount_cents
        : 0;

      if (adjustmentCents !== 0) {
        // Positive adjustment = we over-provisioned, credit back
        // Negative adjustment = we under-provisioned, deduct more
        await tx
          .update(billingAccounts)
          .set({
            creditBalanceCents: rawSql`${billingAccounts.creditBalanceCents} + ${adjustmentCents}`,
            updatedAt: new Date(),
          })
          .where(eq(billingAccounts.orgId, orgId));
      }

      const finalAmount = actual_amount_cents ?? provision.amount_cents;

      await tx
        .update(creditProvisions)
        .set({
          status: "confirmed",
          amountCents: finalAmount,
          updatedAt: new Date(),
        })
        .where(eq(creditProvisions.id, provisionId));

      // Get updated balance
      const [account] = await tx
        .select({ creditBalanceCents: billingAccounts.creditBalanceCents })
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId))
        .limit(1);

      return {
        provision_id: provisionId,
        status: "confirmed" as const,
        original_amount_cents: provision.amount_cents,
        final_amount_cents: finalAmount,
        adjustment_cents: adjustmentCents,
        balance_cents: account?.creditBalanceCents ?? null,
      };
    });

    if ("error" in result && result.error) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }

    res.json(result);
  } catch (err) {
    console.error("Error confirming provision:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /v1/credits/provision/:id/cancel — cancel provision, re-credit balance
router.post("/v1/credits/provision/:id/cancel", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const provisionId = req.params.id;

    const result = await db.transaction(async (tx) => {
      const provRows = await tx.execute<{
        id: string;
        org_id: string;
        amount_cents: number;
        status: string;
      }>(
        rawSql`SELECT * FROM credit_provisions WHERE id = ${provisionId} AND org_id = ${orgId} FOR UPDATE`
      );

      const provision = (provRows as unknown as Array<{
        id: string;
        org_id: string;
        amount_cents: number;
        status: string;
      }>)[0];

      if (!provision) {
        return { error: "Provision not found" as const, status: 404 as const };
      }

      if (provision.status !== "pending") {
        return { error: `Provision already ${provision.status}` as const, status: 409 as const };
      }

      // Re-credit the provisioned amount
      await tx
        .update(billingAccounts)
        .set({
          creditBalanceCents: rawSql`${billingAccounts.creditBalanceCents} + ${provision.amount_cents}`,
          updatedAt: new Date(),
        })
        .where(eq(billingAccounts.orgId, orgId));

      await tx
        .update(creditProvisions)
        .set({
          status: "cancelled",
          updatedAt: new Date(),
        })
        .where(eq(creditProvisions.id, provisionId));

      const [account] = await tx
        .select({ creditBalanceCents: billingAccounts.creditBalanceCents })
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId))
        .limit(1);

      return {
        provision_id: provisionId,
        status: "cancelled" as const,
        refunded_cents: provision.amount_cents,
        balance_cents: account?.creditBalanceCents ?? null,
      };
    });

    if ("error" in result && result.error) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }

    res.json(result);
  } catch (err) {
    console.error("Error cancelling provision:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
