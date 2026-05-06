import { Router } from "express";
import { eq, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, transactions } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { ProvisionRequestSchema, ConfirmProvisionRequestSchema } from "../schemas.js";
import { isStripeAuthError } from "../lib/stripe.js";
import { syncStripeCeilDelta } from "../lib/ledger.js";
import { findOrCreateAccount } from "../lib/account.js";
import { traceEvent } from "../lib/trace-client.js";
import { addCents, subCents, isDepleted, cmpCents } from "../lib/cents.js";

const router = Router();

interface AccountRow {
  id: string;
  org_id: string;
  stripe_customer_id: string | null;
  credit_balance_cents: string;
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

      const oldBalance = account.credit_balance_cents;
      const newBalance = subCents(oldBalance, amount_cents);
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
        depleted: isDepleted(newBalance),
        _oldBalance: oldBalance,
        _customerId: account.stripe_customer_id,
        _provisionLedgerEntryId: provision.id,
      };
    });

    if ("error" in result && result.error) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }

    if (result._customerId && result._provisionLedgerEntryId) {
      syncStripeCeilDelta({
        orgId,
        userId,
        customerId: result._customerId,
        oldBalance: result._oldBalance,
        newBalance: result.balance_cents,
        description,
        ledgerEntryId: result._provisionLedgerEntryId,
        wfHeaders: fwdHeaders,
      });
    }

    const { _customerId: _c, _provisionLedgerEntryId: _pl, _oldBalance: _ob, ...response } = result as Record<string, unknown>;

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
        amount_cents: string;
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
        amount_cents: string;
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
          cmpCents(actual_amount_cents, provision.amount_cents) === 0;
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
          adjustment_cents: "0.0000000000",
          balance_cents: account?.creditBalanceCents ?? null,
        };
      }

      if (provision.status !== "pending") {
        return { error: `Provision already ${provision.status}` as const, status: 409 as const };
      }

      const finalAmount = actual_amount_cents ?? provision.amount_cents;
      const adjustmentCents = subCents(provision.amount_cents, finalAmount);

      // Same amount → flip status only; no balance change, no new row.
      if (cmpCents(adjustmentCents, "0") === 0) {
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
          adjustment_cents: "0.0000000000",
          balance_cents: account?.creditBalanceCents ?? null,
          _customerId: account?.stripeCustomerId ?? null,
          _oldBalance: account?.creditBalanceCents ?? null,
          _adjustmentCents: "0.0000000000",
          _newChargeId: null as string | null,
        };
      }

      // Amount differs: cancel original hold (refund $X) and write a fresh confirmed charge ($Y).
      // Net balance change = (X - Y) = adjustmentCents.
      const [accountBefore] = await tx
        .select({ creditBalanceCents: billingAccounts.creditBalanceCents })
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId))
        .limit(1);
      const oldBalance = accountBefore?.creditBalanceCents ?? null;

      await tx
        .update(billingAccounts)
        .set({
          creditBalanceCents: rawSql`${billingAccounts.creditBalanceCents} + ${adjustmentCents}::numeric`,
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
        _oldBalance: oldBalance,
        _adjustmentCents: adjustmentCents,
        _newChargeId: newCharge.id,
      };
    });

    if ("error" in result && result.error) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }

    // Stripe sync: post ONE ceil-delta sized to the net balance change.
    // The new charge row owns the stripeBalanceTxnId; the cancelled provision row stays null.
    const customerId = "_customerId" in result ? (result._customerId as string | null) : null;
    const oldBal = "_oldBalance" in result ? (result._oldBalance as string | null) : null;
    const newChargeId = "_newChargeId" in result ? (result._newChargeId as string | null) : null;
    if (customerId && oldBal !== null && newChargeId) {
      syncStripeCeilDelta({
        orgId,
        userId,
        customerId,
        oldBalance: oldBal,
        newBalance: result.balance_cents as string,
        description:
          cmpCents(result.original_amount_cents as string, result.final_amount_cents as string) !== 0
            ? `Confirmed charge (replacing provision ${provisionId})`
            : `Provision ${provisionId} confirmed`,
        ledgerEntryId: newChargeId,
        wfHeaders,
      });
    }

    const adjustment = "_adjustmentCents" in result ? (result._adjustmentCents as string) : "0";
    const { _customerId: _c, _adjustmentCents: _a, _newChargeId: _n, _oldBalance: _ob, ...response } = result as Record<string, unknown>;

    traceEvent({
      runId,
      orgId,
      userId,
      event: "billing.provision.confirmed",
      detail: { provision_id: provisionId, adjustment_cents: adjustment as unknown as string },
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
        amount_cents: string;
        status: string;
      }>(
        rawSql`SELECT * FROM transactions WHERE id = ${provisionId} AND org_id = ${orgId} FOR UPDATE`
      );

      const provision = (provRows as unknown as Array<{
        id: string;
        org_id: string;
        amount_cents: string;
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
          refunded_cents: "0.0000000000",
          balance_cents: account?.creditBalanceCents ?? null,
        };
      }

      if (provision.status !== "pending") {
        return { error: `Provision already ${provision.status}` as const, status: 409 as const };
      }

      const [accountBefore] = await tx
        .select({ creditBalanceCents: billingAccounts.creditBalanceCents })
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId))
        .limit(1);
      const oldBalance = accountBefore?.creditBalanceCents ?? null;

      await tx
        .update(billingAccounts)
        .set({
          creditBalanceCents: rawSql`${billingAccounts.creditBalanceCents} + ${provision.amount_cents}::numeric`,
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
        _oldBalance: oldBalance,
      };
    });

    if ("error" in result && result.error) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }

    const customerId = "_customerId" in result ? result._customerId as string | null : null;
    const refundedCents = "_refundedCents" in result ? result._refundedCents as string : "0";
    const oldBal = "_oldBalance" in result ? result._oldBalance as string | null : null;
    if (customerId && oldBal !== null && cmpCents(refundedCents, "0") > 0) {
      syncStripeCeilDelta({
        orgId,
        userId,
        customerId,
        oldBalance: oldBal,
        newBalance: result.balance_cents as string,
        description: `Provision ${provisionId} cancel refund`,
        ledgerEntryId: provisionId,
        wfHeaders,
      });
    }

    const { _customerId: _c, _refundedCents: _r, _oldBalance: _ob, ...response } = result as Record<string, unknown>;

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
