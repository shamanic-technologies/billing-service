import { Router, type Request, type Response } from "express";
import { eq, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, transactions } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { ProvisionRequestSchema, ConfirmProvisionRequestSchema } from "../schemas.js";
import { isStripeAuthError } from "../lib/stripe.js";
import { syncStripeCeilDelta } from "../lib/ledger.js";
import { findOrCreateAccount } from "../lib/account.js";
import { traceEvent } from "../lib/trace-client.js";
import { subCents, isDepleted, cmpCents } from "../lib/cents.js";

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

interface ProvisionRow {
  id: string;
  org_id: string;
  cost_id: string | null;
  amount_cents: string;
  status: string;
  description: string | null;
  campaign_id: string | null;
  brand_ids: string[] | null;
  workflow_slug: string | null;
  feature_slug: string | null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lookupProvisionById(
  tx: Tx,
  provisionId: string,
  orgId: string
): Promise<ProvisionRow | undefined> {
  const rows = await tx.execute(
    rawSql`SELECT id, org_id, cost_id, amount_cents, status, description,
                  campaign_id, brand_ids, workflow_slug, feature_slug
           FROM transactions
           WHERE id = ${provisionId} AND org_id = ${orgId}
           FOR UPDATE`
  );
  return (rows as unknown as ProvisionRow[])[0];
}

async function lookupProvisionByCostId(
  tx: Tx,
  costId: string,
  orgId: string
): Promise<ProvisionRow | undefined> {
  const rows = await tx.execute(
    rawSql`SELECT id, org_id, cost_id, amount_cents, status, description,
                  campaign_id, brand_ids, workflow_slug, feature_slug
           FROM transactions
           WHERE cost_id = ${costId} AND org_id = ${orgId}
           ORDER BY created_at DESC
           LIMIT 1
           FOR UPDATE`
  );
  return (rows as unknown as ProvisionRow[])[0];
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

    const { amount_cents, description, cost_id } = parsed.data;

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
          costId: cost_id,
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
        cost_id: provision.costId ?? null,
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
      detail: { provision_id: result.provision_id, cost_id: result.cost_id, amount_cents, balance_cents: result.balance_cents },
      workflowHeaders: fwdHeaders,
    });

    res.json(response);
  } catch (err) {
    console.error("[billing-service] Error creating provision", {
      run_id: req.headers["x-run-id"],
      org_id: req.headers["x-org-id"],
      user_id: req.headers["x-user-id"],
      err,
    });
    if (isStripeAuthError(err)) {
      res.status(502).json({ error: "Payment provider authentication failed" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Confirm helpers ---

interface ConfirmConflict {
  error: string;
  status: 404 | 409;
  current_status: string | null;
  current_amount_cents: string | null;
}

interface ConfirmSuccess {
  provision_id: string;
  cost_id: string | null;
  status: "confirmed";
  original_amount_cents: string;
  final_amount_cents: string;
  adjustment_cents: string;
  balance_cents: string | null;
  _customerId?: string | null;
  _oldBalance?: string | null;
  _adjustmentCents?: string;
  _newChargeId?: string | null;
}

type ConfirmResult = ConfirmConflict | ConfirmSuccess;

async function performConfirmInTx(
  tx: Tx,
  provision: ProvisionRow | undefined,
  ctx: { orgId: string; userId: string; runId: string },
  actualAmountCents: string | undefined
): Promise<ConfirmResult> {
  if (!provision) {
    return {
      error: "Provision not found",
      status: 404,
      current_status: null,
      current_amount_cents: null,
    };
  }

  // Idempotent: re-confirm with same amount on already-confirmed row is a no-op.
  if (provision.status === "confirmed") {
    const sameAmount =
      actualAmountCents === undefined ||
      cmpCents(actualAmountCents, provision.amount_cents) === 0;
    if (!sameAmount) {
      return {
        error: `Provision already confirmed at ${provision.amount_cents} cents`,
        status: 409,
        current_status: provision.status,
        current_amount_cents: provision.amount_cents,
      };
    }
    const [account] = await tx
      .select({ creditBalanceCents: billingAccounts.creditBalanceCents })
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, ctx.orgId))
      .limit(1);

    return {
      provision_id: provision.id,
      cost_id: provision.cost_id,
      status: "confirmed",
      original_amount_cents: provision.amount_cents,
      final_amount_cents: provision.amount_cents,
      adjustment_cents: "0.0000000000",
      balance_cents: account?.creditBalanceCents ?? null,
    };
  }

  if (provision.status !== "pending") {
    return {
      error: `Provision already ${provision.status}`,
      status: 409,
      current_status: provision.status,
      current_amount_cents: provision.amount_cents,
    };
  }

  const finalAmount = actualAmountCents ?? provision.amount_cents;
  const adjustmentCents = subCents(provision.amount_cents, finalAmount);

  if (cmpCents(adjustmentCents, "0") === 0) {
    await tx
      .update(transactions)
      .set({ status: "confirmed", updatedAt: new Date() })
      .where(eq(transactions.id, provision.id));

    const [account] = await tx
      .select({
        creditBalanceCents: billingAccounts.creditBalanceCents,
        stripeCustomerId: billingAccounts.stripeCustomerId,
      })
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, ctx.orgId))
      .limit(1);

    return {
      provision_id: provision.id,
      cost_id: provision.cost_id,
      status: "confirmed",
      original_amount_cents: provision.amount_cents,
      final_amount_cents: finalAmount,
      adjustment_cents: "0.0000000000",
      balance_cents: account?.creditBalanceCents ?? null,
      _customerId: account?.stripeCustomerId ?? null,
      _oldBalance: account?.creditBalanceCents ?? null,
      _adjustmentCents: "0.0000000000",
      _newChargeId: null,
    };
  }

  // Amount differs: cancel original hold (refund $X) and write a fresh confirmed charge ($Y).
  const [accountBefore] = await tx
    .select({ creditBalanceCents: billingAccounts.creditBalanceCents })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, ctx.orgId))
    .limit(1);
  const oldBalance = accountBefore?.creditBalanceCents ?? null;

  await tx
    .update(billingAccounts)
    .set({
      creditBalanceCents: rawSql`${billingAccounts.creditBalanceCents} + ${adjustmentCents}::numeric`,
      updatedAt: new Date(),
    })
    .where(eq(billingAccounts.orgId, ctx.orgId));

  await tx
    .update(transactions)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(transactions.id, provision.id));

  // Carry cost_id onto the replacement row so future calls can still find it.
  const [newCharge] = await tx
    .insert(transactions)
    .values({
      orgId: ctx.orgId,
      userId: ctx.userId,
      runId: ctx.runId,
      costId: provision.cost_id,
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
    .where(eq(billingAccounts.orgId, ctx.orgId))
    .limit(1);

  // provision_id in the response points to the active confirmed row,
  // not the cancelled original — so by-cost callers can re-confirm idempotently.
  return {
    provision_id: newCharge.id,
    cost_id: provision.cost_id,
    status: "confirmed",
    original_amount_cents: provision.amount_cents,
    final_amount_cents: finalAmount,
    adjustment_cents: adjustmentCents,
    balance_cents: account?.creditBalanceCents ?? null,
    _customerId: account?.stripeCustomerId ?? null,
    _oldBalance: oldBalance,
    _adjustmentCents: adjustmentCents,
    _newChargeId: newCharge.id,
  };
}

interface ConfirmHandlerArgs {
  req: Request;
  res: Response;
  // identifier echoed back in error/log payload — provision_id when the path-id route is used; null when looking up by cost_id
  reqProvisionId: string | null;
  reqCostId: string | null;
  lookup: (tx: Tx, orgId: string) => Promise<ProvisionRow | undefined>;
}

async function handleConfirm({
  req,
  res,
  reqProvisionId,
  reqCostId,
  lookup,
}: ConfirmHandlerArgs): Promise<void> {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const parsed = ConfirmProvisionRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { actual_amount_cents } = parsed.data;

    const result = await db.transaction(async (tx) => {
      const provision = await lookup(tx, orgId);
      return performConfirmInTx(tx, provision, { orgId, userId, runId }, actual_amount_cents);
    });

    if ("error" in result && result.error) {
      const conflict = result as ConfirmConflict;
      console.warn("[billing-service] provision confirm rejected", {
        provision_id: reqProvisionId,
        cost_id: reqCostId,
        run_id: runId,
        org_id: orgId,
        user_id: userId,
        status_code: conflict.status,
        error: conflict.error,
        current_status: conflict.current_status,
        current_amount_cents: conflict.current_amount_cents,
        requested_amount_cents: actual_amount_cents ?? null,
      });
      res.status(conflict.status).json({
        error: conflict.error,
        provision_id: reqProvisionId,
        cost_id: reqCostId,
        run_id: runId,
        current_status: conflict.current_status,
        current_amount_cents: conflict.current_amount_cents,
        requested_amount_cents: actual_amount_cents ?? null,
      });
      return;
    }

    const success = result as ConfirmSuccess;

    // Stripe sync: post ONE ceil-delta sized to the net balance change.
    if (success._customerId && success._oldBalance !== undefined && success._oldBalance !== null && success._newChargeId) {
      syncStripeCeilDelta({
        orgId,
        userId,
        customerId: success._customerId,
        oldBalance: success._oldBalance,
        newBalance: success.balance_cents as string,
        description:
          cmpCents(success.original_amount_cents, success.final_amount_cents) !== 0
            ? `Confirmed charge (replacing provision ${success.provision_id})`
            : `Provision ${success.provision_id} confirmed`,
        ledgerEntryId: success._newChargeId,
        wfHeaders,
      });
    }

    const adjustment = success._adjustmentCents ?? "0";
    const { _customerId, _adjustmentCents, _newChargeId, _oldBalance, ...response } = success;
    void _customerId;
    void _adjustmentCents;
    void _newChargeId;
    void _oldBalance;

    traceEvent({
      runId,
      orgId,
      userId,
      event: "billing.provision.confirmed",
      detail: { provision_id: success.provision_id, cost_id: success.cost_id, adjustment_cents: adjustment },
      workflowHeaders: wfHeaders,
    });

    res.json(response);
  } catch (err) {
    console.error("[billing-service] Error confirming provision", {
      provision_id: reqProvisionId,
      cost_id: reqCostId,
      run_id: req.headers["x-run-id"],
      org_id: req.headers["x-org-id"],
      user_id: req.headers["x-user-id"],
      err,
    });
    res.status(500).json({ error: "Internal server error" });
  }
}

// --- Cancel helpers ---

interface CancelConflict {
  error: string;
  status: 404 | 409;
  current_status: string | null;
  current_amount_cents: string | null;
}

interface CancelSuccess {
  provision_id: string;
  cost_id: string | null;
  status: "cancelled";
  refunded_cents: string;
  balance_cents: string | null;
  _customerId?: string | null;
  _refundedCents?: string;
  _oldBalance?: string | null;
}

type CancelResult = CancelConflict | CancelSuccess;

async function performCancelInTx(
  tx: Tx,
  provision: ProvisionRow | undefined,
  ctx: { orgId: string }
): Promise<CancelResult> {
  if (!provision) {
    return {
      error: "Provision not found",
      status: 404,
      current_status: null,
      current_amount_cents: null,
    };
  }

  if (provision.status === "cancelled") {
    const [account] = await tx
      .select({ creditBalanceCents: billingAccounts.creditBalanceCents })
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, ctx.orgId))
      .limit(1);

    return {
      provision_id: provision.id,
      cost_id: provision.cost_id,
      status: "cancelled",
      refunded_cents: "0.0000000000",
      balance_cents: account?.creditBalanceCents ?? null,
    };
  }

  if (provision.status !== "pending") {
    return {
      error: `Provision already ${provision.status}`,
      status: 409,
      current_status: provision.status,
      current_amount_cents: provision.amount_cents,
    };
  }

  const [accountBefore] = await tx
    .select({ creditBalanceCents: billingAccounts.creditBalanceCents })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, ctx.orgId))
    .limit(1);
  const oldBalance = accountBefore?.creditBalanceCents ?? null;

  await tx
    .update(billingAccounts)
    .set({
      creditBalanceCents: rawSql`${billingAccounts.creditBalanceCents} + ${provision.amount_cents}::numeric`,
      updatedAt: new Date(),
    })
    .where(eq(billingAccounts.orgId, ctx.orgId));

  await tx
    .update(transactions)
    .set({
      status: "cancelled",
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, provision.id));

  const [account] = await tx
    .select({
      creditBalanceCents: billingAccounts.creditBalanceCents,
      stripeCustomerId: billingAccounts.stripeCustomerId,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, ctx.orgId))
    .limit(1);

  return {
    provision_id: provision.id,
    cost_id: provision.cost_id,
    status: "cancelled",
    refunded_cents: provision.amount_cents,
    balance_cents: account?.creditBalanceCents ?? null,
    _customerId: account?.stripeCustomerId ?? null,
    _refundedCents: provision.amount_cents,
    _oldBalance: oldBalance,
  };
}

interface CancelHandlerArgs {
  req: Request;
  res: Response;
  reqProvisionId: string | null;
  reqCostId: string | null;
  lookup: (tx: Tx, orgId: string) => Promise<ProvisionRow | undefined>;
}

async function handleCancel({
  req,
  res,
  reqProvisionId,
  reqCostId,
  lookup,
}: CancelHandlerArgs): Promise<void> {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));

    const result = await db.transaction(async (tx) => {
      const provision = await lookup(tx, orgId);
      return performCancelInTx(tx, provision, { orgId });
    });

    if ("error" in result && result.error) {
      const conflict = result as CancelConflict;
      console.warn("[billing-service] provision cancel rejected", {
        provision_id: reqProvisionId,
        cost_id: reqCostId,
        run_id: runId,
        org_id: orgId,
        user_id: userId,
        status_code: conflict.status,
        error: conflict.error,
        current_status: conflict.current_status,
        current_amount_cents: conflict.current_amount_cents,
      });
      res.status(conflict.status).json({
        error: conflict.error,
        provision_id: reqProvisionId,
        cost_id: reqCostId,
        run_id: runId,
        current_status: conflict.current_status,
        current_amount_cents: conflict.current_amount_cents,
      });
      return;
    }

    const success = result as CancelSuccess;

    if (
      success._customerId &&
      success._oldBalance !== undefined &&
      success._oldBalance !== null &&
      success._refundedCents &&
      cmpCents(success._refundedCents, "0") > 0
    ) {
      syncStripeCeilDelta({
        orgId,
        userId,
        customerId: success._customerId,
        oldBalance: success._oldBalance,
        newBalance: success.balance_cents as string,
        description: `Provision ${success.provision_id} cancel refund`,
        ledgerEntryId: success.provision_id,
        wfHeaders,
      });
    }

    const refundedCents = success._refundedCents ?? "0";
    const { _customerId, _refundedCents, _oldBalance, ...response } = success;
    void _customerId;
    void _refundedCents;
    void _oldBalance;

    traceEvent({
      runId,
      orgId,
      userId,
      event: "billing.provision.cancelled",
      detail: { provision_id: success.provision_id, cost_id: success.cost_id, refunded_cents: refundedCents },
      workflowHeaders: wfHeaders,
    });

    res.json(response);
  } catch (err) {
    console.error("[billing-service] Error cancelling provision", {
      provision_id: reqProvisionId,
      cost_id: reqCostId,
      run_id: req.headers["x-run-id"],
      org_id: req.headers["x-org-id"],
      user_id: req.headers["x-user-id"],
      err,
    });
    res.status(500).json({ error: "Internal server error" });
  }
}

// --- Routes ---

// POST /v1/credits/provision/:id/confirm — confirm provision by billing-internal id
router.post("/v1/credits/provision/:id/confirm", requireOrgHeaders, async (req, res) => {
  const provisionId = req.params.id;
  await handleConfirm({
    req,
    res,
    reqProvisionId: provisionId,
    reqCostId: null,
    lookup: (tx, orgId) => lookupProvisionById(tx, provisionId, orgId),
  });
});

// POST /v1/credits/provision/:id/cancel — cancel provision by billing-internal id
router.post("/v1/credits/provision/:id/cancel", requireOrgHeaders, async (req, res) => {
  const provisionId = req.params.id;
  await handleCancel({
    req,
    res,
    reqProvisionId: provisionId,
    reqCostId: null,
    lookup: (tx, orgId) => lookupProvisionById(tx, provisionId, orgId),
  });
});

// POST /v1/credits/provision/by-cost/:cost_id/confirm — confirm provision by natural cost_id key
router.post("/v1/credits/provision/by-cost/:cost_id/confirm", requireOrgHeaders, async (req, res) => {
  const costId = req.params.cost_id;
  await handleConfirm({
    req,
    res,
    reqProvisionId: null,
    reqCostId: costId,
    lookup: (tx, orgId) => lookupProvisionByCostId(tx, costId, orgId),
  });
});

// POST /v1/credits/provision/by-cost/:cost_id/cancel — cancel provision by natural cost_id key
router.post("/v1/credits/provision/by-cost/:cost_id/cancel", requireOrgHeaders, async (req, res) => {
  const costId = req.params.cost_id;
  await handleCancel({
    req,
    res,
    reqProvisionId: null,
    reqCostId: costId,
    lookup: (tx, orgId) => lookupProvisionByCostId(tx, costId, orgId),
  });
});

export default router;
