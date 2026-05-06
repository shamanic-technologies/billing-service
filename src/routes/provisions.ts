import { Router } from "express";
import { eq, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, transactions } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { ProvisionRequestSchema, ConfirmProvisionRequestSchema } from "../schemas.js";
import { isStripeAuthError } from "../lib/stripe.js";
import { fireAndForgetBalanceTxn } from "../lib/ledger.js";
import { findOrCreateAccount } from "../lib/account.js";
import { traceEvent } from "../lib/trace-client.js";

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

// POST /v1/credits/provision — provision credits (deduct from balance immediately, status=pending)
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

    await findOrCreateAccount(orgId, userId, fwdHeaders);

    const result = await db.transaction(async (tx) => {
      const rows = await tx.execute(
        rawSql`SELECT * FROM billing_accounts WHERE org_id = ${orgId} FOR UPDATE`
      );

      const account = (rows as unknown as AccountRow[])[0];
      if (!account) {
        return { error: "Billing account not found" as const, status: 404 as const };
      }

      const newBalance = account.credit_balance_cents - amount_cents;
      await tx
        .update(billingAccounts)
        .set({
          creditBalanceCents: newBalance,
          updatedAt: new Date(),
        })
        .where(eq(billingAccounts.orgId, orgId));

      const [provision] = await tx
        .insert(transactions)
        .values({
          orgId,
          userId,
          runId,
          type: "debit",
          amountCents: amount_cents,
          status: "pending",
          source: "charge",
          description,
          campaignId: wfHeaders.campaignId,
          brandIds: wfHeaders.brandIds,
          workflowSlug: wfHeaders.workflowSlug,
          featureSlug: wfHeaders.featureSlug,
        })
        .returning();

      return {
        provision_id: provision.id,
        balance_cents: newBalance,
        depleted: newBalance <= 0,
        _customerId: account.stripe_customer_id,
        _provisionLedgerEntryId: provision.id,
      };
    });

    if ("error" in result && result.error) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }

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

    const { _customerId: _c, _provisionLedgerEntryId: _pl, ...response } = result as Record<string, unknown>;

    traceEvent({
      runId,
      orgId,
      userId,
      event: "billing.provision.created",
      detail: { provision_id: result.provision_id, amount_cents, balance_cents: result.balance_cents },
      workflowHeaders: fwdHeaders,
    });

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

// POST /v1/credits/provision/:id/confirm — confirm provision; on amount mismatch, cancel original and write a fresh charge.
router.post("/v1/credits/provision/:id/confirm", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeadersRaw = getWorkflowHeaders(req);
    const wfHeaders = forwardWorkflowHeaders(wfHeadersRaw);
    const provisionId = req.params.id;
    const parsed = ConfirmProvisionRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { actual_amount_cents } = parsed.data;

    const result = await db.transaction(async (tx) => {
      const provRows = await tx.execute<{
        id: string;
        org_id: string;
        amount_cents: number;
        status: string;
        description: string | null;
        campaign_id: string | null;
        brand_ids: string[] | null;
        workflow_slug: string | null;
        feature_slug: string | null;
      }>(
        rawSql`SELECT * FROM transactions WHERE id = ${provisionId} AND org_id = ${orgId} FOR UPDATE`
      );

      const provision = (provRows as unknown as Array<{
        id: string;
        org_id: string;
        amount_cents: number;
        status: string;
        description: string | null;
        campaign_id: string | null;
        brand_ids: string[] | null;
        workflow_slug: string | null;
        feature_slug: string | null;
      }>)[0];

      if (!provision) {
        return { error: "Provision not found" as const, status: 404 as const };
      }

      // Idempotent: confirm with same amount on already-confirmed row is a no-op.
      if (provision.status === "confirmed") {
        const sameAmount =
          actual_amount_cents === undefined ||
          actual_amount_cents === provision.amount_cents;
        if (!sameAmount) {
          return {
            error: `Provision already confirmed at ${provision.amount_cents} cents` as const,
            status: 409 as const,
          };
        }
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

      const finalAmount = actual_amount_cents ?? provision.amount_cents;
      const adjustmentCents = provision.amount_cents - finalAmount;

      // Same amount → flip status only; no balance change, no new row.
      if (adjustmentCents === 0) {
        await tx
          .update(transactions)
          .set({ status: "confirmed", updatedAt: new Date() })
          .where(eq(transactions.id, provisionId));

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
          adjustment_cents: 0,
          balance_cents: account?.creditBalanceCents ?? null,
          _customerId: account?.stripeCustomerId ?? null,
          _adjustmentCents: 0,
          _newChargeId: null as string | null,
        };
      }

      // Amount differs: cancel original hold (refund $X) and write a fresh confirmed charge ($Y).
      // Net balance change = (X - Y) = adjustmentCents.
      await tx
        .update(billingAccounts)
        .set({
          creditBalanceCents: rawSql`${billingAccounts.creditBalanceCents} + ${adjustmentCents}`,
          updatedAt: new Date(),
        })
        .where(eq(billingAccounts.orgId, orgId));

      await tx
        .update(transactions)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(transactions.id, provisionId));

      const [newCharge] = await tx
        .insert(transactions)
        .values({
          orgId,
          userId,
          runId,
          type: "debit",
          amountCents: finalAmount,
          status: "confirmed",
          source: "charge",
          description: provision.description,
          campaignId: provision.campaign_id ?? undefined,
          brandIds: provision.brand_ids ?? undefined,
          workflowSlug: provision.workflow_slug ?? undefined,
          featureSlug: provision.feature_slug ?? undefined,
        })
        .returning();

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
        _newChargeId: newCharge.id,
      };
    });

    if ("error" in result && result.error) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }

    // Stripe sync: when amount changes, post a refund of the original hold AND a charge for the new amount.
    // Each fires against its own ledger row id (refund → original provision row, charge → newly inserted row).
    const customerId = "_customerId" in result ? (result._customerId as string | null) : null;
    const adjustment = "_adjustmentCents" in result ? (result._adjustmentCents as number) : 0;
    const newChargeId = "_newChargeId" in result ? (result._newChargeId as string | null) : null;
    if (customerId && adjustment !== 0 && newChargeId) {
      // Refund the original $X to the customer's Stripe balance (negative amount for credit).
      fireAndForgetBalanceTxn(
        orgId,
        userId,
        customerId,
        -result.original_amount_cents,
        `Provision ${provisionId} cancelled (replaced by confirm at ${result.final_amount_cents} cents)`,
        provisionId,
        wfHeaders
      );
      // Charge the new $Y on Stripe balance (positive amount for debit).
      fireAndForgetBalanceTxn(
        orgId,
        userId,
        customerId,
        result.final_amount_cents,
        result.original_amount_cents !== result.final_amount_cents
          ? `Confirmed charge (replacing provision ${provisionId})`
          : `Provision ${provisionId} confirmed`,
        newChargeId,
        wfHeaders
      );
    }

    const { _customerId: _c, _adjustmentCents: _a, _newChargeId: _n, ...response } = result as Record<string, unknown>;

    traceEvent({
      runId,
      orgId,
      userId,
      event: "billing.provision.confirmed",
      detail: { provision_id: provisionId, adjustment_cents: adjustment },
      workflowHeaders: wfHeaders,
    });

    res.json(response);
  } catch (err) {
    console.error("[billing-service] Error confirming provision:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /v1/credits/provision/:id/cancel — cancel provision, re-credit balance. No miroir row.
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
        rawSql`SELECT * FROM transactions WHERE id = ${provisionId} AND org_id = ${orgId} FOR UPDATE`
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

      await tx
        .update(billingAccounts)
        .set({
          creditBalanceCents: rawSql`${billingAccounts.creditBalanceCents} + ${provision.amount_cents}`,
          updatedAt: new Date(),
        })
        .where(eq(billingAccounts.orgId, orgId));

      await tx
        .update(transactions)
        .set({
          status: "cancelled",
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, provisionId));

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

    const { _customerId: _c, _refundedCents: _r, ...response } = result as Record<string, unknown>;

    traceEvent({
      runId: req.headers["x-run-id"] as string,
      orgId,
      userId,
      event: "billing.provision.cancelled",
      detail: { provision_id: provisionId, refunded_cents: refundedCents },
      workflowHeaders: wfHeaders,
    });

    res.json(response);
  } catch (err) {
    console.error("[billing-service] Error cancelling provision:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
