import { Router } from "express";
import { eq, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, creditLedger } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { ProvisionRequestSchema, ConfirmProvisionRequestSchema } from "../schemas.js";
import {
  chargePaymentMethod,
  isStripeAuthError,
} from "../lib/stripe.js";
import { fireAndForgetBalanceTxn } from "../lib/ledger.js";
import { sendEmail } from "../lib/email-client.js";
import { findOrCreateAccount } from "../lib/account.js";

const router = Router();

interface AccountRow {
  id: string;
  org_id: string;
  stripe_customer_id: string | null;
  credit_balance_cents: number;
  reload_amount_cents: number | null;
  reload_threshold_cents: number | null;
  stripe_payment_method_id: string | null;
}

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
      const rows = await tx.execute(
        rawSql`SELECT * FROM billing_accounts WHERE org_id = ${orgId} FOR UPDATE`
      );

      const account = (rows as unknown as AccountRow[])[0];
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
        .insert(creditLedger)
        .values({
          orgId,
          userId,
          runId,
          type: "debit",
          amountCents: amount_cents,
          status: "pending",
          source: "provision",
          description,
          campaignId: wfHeaders.campaignId,
          brandIds: wfHeaders.brandIds,
          workflowSlug: wfHeaders.workflowSlug,
          featureSlug: wfHeaders.featureSlug,
        })
        .returning();

      // Auto-reload: if balance dropped below threshold, create a credit entry
      // and increment balance INSIDE the transaction to prevent concurrent race conditions
      let creditLedgerEntryId: string | null = null;
      let reloadAmount: number | null = null;
      const threshold = account.reload_threshold_cents ?? 200;
      if (
        newBalance < threshold &&
        account.stripe_payment_method_id &&
        account.stripe_customer_id &&
        account.reload_amount_cents
      ) {
        reloadAmount = account.reload_amount_cents;
        const [creditEntry] = await tx
          .insert(creditLedger)
          .values({
            orgId,
            userId,
            type: "credit",
            amountCents: reloadAmount,
            status: "pending",
            source: "reload",
            description: `Auto-reload credit ($${(reloadAmount / 100).toFixed(2)})`,
          })
          .returning();
        creditLedgerEntryId = creditEntry.id;

        // Increment balance immediately (optimistic — will be reversed if Stripe fails)
        await tx
          .update(billingAccounts)
          .set({
            creditBalanceCents: rawSql`${billingAccounts.creditBalanceCents} + ${reloadAmount}`,
            updatedAt: new Date(),
          })
          .where(eq(billingAccounts.orgId, orgId));
      }

      return {
        provision_id: provision.id,
        balance_cents: newBalance + (reloadAmount ?? 0),
        depleted: newBalance <= 0,
        _creditLedgerEntryId: creditLedgerEntryId,
        _reloadAmount: reloadAmount,
        _customerId: account.stripe_customer_id,
        _pmId: account.stripe_payment_method_id,
        _provisionLedgerEntryId: provision.id,
      };
    });

    if ("error" in result && result.error) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }

    // Fire-and-forget Stripe balance txn for the provision debit
    if (result._customerId && result._provisionLedgerEntryId) {
      fireAndForgetBalanceTxn(
        orgId,
        userId,
        result._customerId,
        amount_cents,
        description,
        result._provisionLedgerEntryId,
        fwdHeaders
      );
    }

    // Async Stripe charge for reload credit entry (fire-and-forget)
    const creditLedgerEntryId = "_creditLedgerEntryId" in result ? result._creditLedgerEntryId as string | null : null;
    const reloadAmount = "_reloadAmount" in result ? result._reloadAmount as number | null : null;
    const customerId = "_customerId" in result ? result._customerId as string | null : null;
    const pmId = "_pmId" in result ? result._pmId as string | null : null;

    if (creditLedgerEntryId && reloadAmount && customerId && pmId) {
      (async () => {
        try {
          const pi = await chargePaymentMethod(orgId, userId, customerId, pmId, reloadAmount, "Auto-reload", fwdHeaders);
          await db
            .update(creditLedger)
            .set({
              status: "confirmed",
              stripePaymentIntentId: pi.id,
              updatedAt: new Date(),
            })
            .where(eq(creditLedger.id, creditLedgerEntryId));

          // Fire-and-forget Stripe balance txn for the reload credit
          fireAndForgetBalanceTxn(
            orgId,
            userId,
            customerId,
            -reloadAmount,
            `Auto-reload credit ($${(reloadAmount / 100).toFixed(2)})`,
            creditLedgerEntryId,
            fwdHeaders
          );
        } catch (err) {
          console.error("[billing-service] Async auto-reload failed, reversing credit entry:", err);
          // Reverse: cancel credit entry + decrement balance
          await db.transaction(async (rollbackTx) => {
            await rollbackTx
              .update(creditLedger)
              .set({ status: "cancelled", updatedAt: new Date() })
              .where(eq(creditLedger.id, creditLedgerEntryId));
            await rollbackTx
              .update(billingAccounts)
              .set({
                creditBalanceCents: rawSql`${billingAccounts.creditBalanceCents} - ${reloadAmount}`,
                updatedAt: new Date(),
              })
              .where(eq(billingAccounts.orgId, orgId));
          });
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
    if ("depleted" in result && result.depleted) {
      sendEmail({
        eventType: "credits-depleted",
        orgId,
        userId,
        runId,
        workflowHeaders: fwdHeaders,
      });
    }

    // Strip internal fields from response
    const { _creditLedgerEntryId: _, _reloadAmount: _r, _customerId: _c, _pmId: _p, _provisionLedgerEntryId: _pl, ...response } = result as Record<string, unknown>;
    res.json(response);
  } catch (err) {
    console.error("[billing-service] Error creating provision:", err);
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
    const userId = req.headers["x-user-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
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
        rawSql`SELECT * FROM credit_ledger WHERE id = ${provisionId} AND org_id = ${orgId} FOR UPDATE`
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

      if (provision.status === "confirmed") {
        // Idempotent: already confirmed — return current state as no-op
        const [account] = await tx
          .select({ creditBalanceCents: billingAccounts.creditBalanceCents })
          .from(billingAccounts)
          .where(eq(billingAccounts.orgId, orgId))
          .limit(1);

        return {
          provision_id: provisionId,
          status: "confirmed" as const,
          original_amount_cents: provision.amount_cents,
          final_amount_cents: provision.amount_cents,
          adjustment_cents: 0,
          balance_cents: account?.creditBalanceCents ?? null,
        };
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

        // Insert adjustment ledger entry
        await tx
          .insert(creditLedger)
          .values({
            orgId,
            userId,
            type: adjustmentCents > 0 ? "credit" : "debit",
            amountCents: Math.abs(adjustmentCents),
            status: "confirmed",
            source: "provision_adjust",
            description: `Provision ${provisionId} adjustment: ${adjustmentCents > 0 ? "+" : ""}${adjustmentCents} cents`,
          });
      }

      const finalAmount = actual_amount_cents ?? provision.amount_cents;

      await tx
        .update(creditLedger)
        .set({
          status: "confirmed",
          amountCents: finalAmount,
          updatedAt: new Date(),
        })
        .where(eq(creditLedger.id, provisionId));

      // Get updated balance and customer ID for Stripe balance txn
      const [account] = await tx
        .select({
          creditBalanceCents: billingAccounts.creditBalanceCents,
          stripeCustomerId: billingAccounts.stripeCustomerId,
        })
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
        _customerId: account?.stripeCustomerId ?? null,
        _adjustmentCents: adjustmentCents,
      };
    });

    if ("error" in result && result.error) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }

    // Fire-and-forget Stripe balance txn for the adjustment (if any)
    const customerId = "_customerId" in result ? result._customerId as string | null : null;
    const adjustment = "_adjustmentCents" in result ? result._adjustmentCents as number : 0;
    if (customerId && adjustment !== 0) {
      // adjustment > 0 means credit back → negative Stripe amount
      // adjustment < 0 means deduct more → positive Stripe amount
      const stripeAmount = -adjustment;
      fireAndForgetBalanceTxn(
        orgId,
        userId,
        customerId,
        stripeAmount,
        `Provision ${provisionId} adjustment`,
        provisionId,
        wfHeaders
      );
    }

    // Strip internal fields
    const { _customerId: _c, _adjustmentCents: _a, ...response } = result as Record<string, unknown>;
    res.json(response);
  } catch (err) {
    console.error("[billing-service] Error confirming provision:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /v1/credits/provision/:id/cancel — cancel provision, re-credit balance
router.post("/v1/credits/provision/:id/cancel", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const provisionId = req.params.id;

    const result = await db.transaction(async (tx) => {
      const provRows = await tx.execute<{
        id: string;
        org_id: string;
        amount_cents: number;
        status: string;
      }>(
        rawSql`SELECT * FROM credit_ledger WHERE id = ${provisionId} AND org_id = ${orgId} FOR UPDATE`
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

      if (provision.status === "cancelled") {
        // Idempotent: already cancelled — return current state as no-op
        const [account] = await tx
          .select({ creditBalanceCents: billingAccounts.creditBalanceCents })
          .from(billingAccounts)
          .where(eq(billingAccounts.orgId, orgId))
          .limit(1);

        return {
          provision_id: provisionId,
          status: "cancelled" as const,
          refunded_cents: 0,
          balance_cents: account?.creditBalanceCents ?? null,
        };
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
        .update(creditLedger)
        .set({
          status: "cancelled",
          updatedAt: new Date(),
        })
        .where(eq(creditLedger.id, provisionId));

      // Insert cancel refund ledger entry
      await tx
        .insert(creditLedger)
        .values({
          orgId,
          userId,
          type: "credit",
          amountCents: provision.amount_cents,
          status: "confirmed",
          source: "provision_cancel",
          description: `Provision ${provisionId} cancelled — refund`,
        });

      const [account] = await tx
        .select({
          creditBalanceCents: billingAccounts.creditBalanceCents,
          stripeCustomerId: billingAccounts.stripeCustomerId,
        })
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId))
        .limit(1);

      return {
        provision_id: provisionId,
        status: "cancelled" as const,
        refunded_cents: provision.amount_cents,
        balance_cents: account?.creditBalanceCents ?? null,
        _customerId: account?.stripeCustomerId ?? null,
        _refundedCents: provision.amount_cents,
      };
    });

    if ("error" in result && result.error) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }

    // Fire-and-forget Stripe balance txn for the refund
    const customerId = "_customerId" in result ? result._customerId as string | null : null;
    const refundedCents = "_refundedCents" in result ? result._refundedCents as number : 0;
    if (customerId && refundedCents > 0) {
      fireAndForgetBalanceTxn(
        orgId,
        userId,
        customerId,
        -refundedCents,
        `Provision ${provisionId} cancel refund`,
        provisionId,
        wfHeaders
      );
    }

    // Strip internal fields
    const { _customerId: _c, _refundedCents: _r, ...response } = result as Record<string, unknown>;
    res.json(response);
  } catch (err) {
    console.error("[billing-service] Error cancelling provision:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
