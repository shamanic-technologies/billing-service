import { Router } from "express";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, customerBalanceTransactions } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { UpdateAutoTopupRequestSchema } from "../schemas.js";
import { isStripeAuthError } from "../lib/stripe.js";
import { findOrCreateAccount } from "../lib/account.js";
import { isDepleted, subCents } from "../lib/cents.js";
import { fetchRunsOrgUsageTotal } from "../lib/runs-client.js";

const router = Router();

function buildAccountResponse(
  account: typeof billingAccounts.$inferSelect,
  usageCents: string
) {
  return {
    id: account.id,
    org_id: account.orgId,
    balance_cents: account.balanceCents,
    usage_cents: usageCents,
    available_cents: subCents(account.balanceCents, usageCents),
    topup_amount_cents: account.topupAmountCents,
    topup_threshold_cents: account.topupThresholdCents,
    has_payment_method: !!account.stripePaymentMethodId,
    has_auto_topup: !!(account.topupAmountCents && account.stripePaymentMethodId),
    stripe_customer_id: account.stripeCustomerId,
    created_at: account.createdAt.toISOString(),
    updated_at: account.updatedAt.toISOString(),
  };
}

function buildRunsHeaders(
  orgId: string,
  userId: string,
  runId: string,
  wfHeaders: Record<string, string>
): Record<string, string> {
  return {
    "x-org-id": orgId,
    "x-user-id": userId,
    "x-run-id": runId,
    ...wfHeaders,
  };
}

// GET /v1/accounts — get or auto-create billing account
router.get("/v1/accounts", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));

    const account = await findOrCreateAccount(orgId, userId, wfHeaders);

    let usage;
    try {
      usage = await fetchRunsOrgUsageTotal(
        orgId,
        buildRunsHeaders(orgId, userId, runId, wfHeaders)
      );
    } catch (runsErr) {
      console.error(
        "[billing-service] Failed to fetch usage total from runs-service:",
        runsErr
      );
      res
        .status(502)
        .json({ error: "Failed to fetch usage total from runs-service" });
      return;
    }

    res.json(buildAccountResponse(account, usage.spent_cents));
  } catch (err) {
    console.error("[billing-service] Error getting/creating account:", err);
    if (isStripeAuthError(err)) {
      res.status(502).json({ error: "Payment provider authentication failed" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /v1/accounts/balance — fast available-funds check
router.get("/v1/accounts/balance", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));

    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    if (!account) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }

    const usage = await fetchRunsOrgUsageTotal(
      orgId,
      buildRunsHeaders(orgId, userId, runId, wfHeaders)
    );
    const availableCents = subCents(account.balanceCents, usage.spent_cents);

    res.json({
      available_cents: availableCents,
      depleted: isDepleted(availableCents),
    });
  } catch (err) {
    console.error("[billing-service] Error checking balance:", err);
    if (isStripeAuthError(err)) {
      res.status(502).json({ error: "Payment provider authentication failed" });
      return;
    }
    if (err instanceof Error && err.message.includes("runs-service")) {
      res.status(502).json({ error: "Failed to fetch usage total from runs-service" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /v1/customer_balance_transactions — Stripe-aligned ledger history.
// Excludes 'usage_applied' (frozen post-#104; runs-service owns usage truth).
router.get(
  "/v1/customer_balance_transactions",
  requireOrgHeaders,
  async (req, res) => {
    try {
      const orgId = req.headers["x-org-id"] as string;

      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId))
        .limit(1);

      if (!account) {
        res.status(404).json({ error: "Billing account not found" });
        return;
      }

      const rows = await db
        .select()
        .from(customerBalanceTransactions)
        .where(
          and(
            eq(customerBalanceTransactions.orgId, orgId),
            ne(customerBalanceTransactions.type, "usage_applied")
          )
        )
        .orderBy(desc(customerBalanceTransactions.createdAt))
        .limit(50);

      const data = rows.map((txn) => ({
        id: txn.id,
        object: "customer_balance_transaction" as const,
        amount_cents: txn.amountCents,
        type: txn.type,
        status: txn.status,
        stripe_payment_intent_id: txn.stripePaymentIntentId,
        stripe_balance_transaction_id: txn.stripeBalanceTransactionId,
        cost_id: txn.costId,
        description: txn.description,
        created: Math.floor(txn.createdAt.getTime() / 1000),
      }));

      res.json({ object: "list", data, has_more: false });
    } catch (err) {
      console.error("[billing-service] Error listing customer balance transactions:", err);
      if (isStripeAuthError(err)) {
        res.status(502).json({ error: "Payment provider authentication failed" });
        return;
      }
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

async function fetchUsageOr502(
  orgId: string,
  userId: string,
  runId: string,
  wfHeaders: Record<string, string>,
  res: import("express").Response
): Promise<string | null> {
  try {
    const usage = await fetchRunsOrgUsageTotal(
      orgId,
      buildRunsHeaders(orgId, userId, runId, wfHeaders)
    );
    return usage.spent_cents;
  } catch (runsErr) {
    console.error(
      "[billing-service] Failed to fetch usage total from runs-service:",
      runsErr
    );
    res
      .status(502)
      .json({ error: "Failed to fetch usage total from runs-service" });
    return null;
  }
}

// PATCH /v1/accounts/auto_topup — configure auto-topup settings
router.patch("/v1/accounts/auto_topup", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const parsed = UpdateAutoTopupRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { topup_amount_cents, topup_threshold_cents } = parsed.data;

    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    if (!account) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }

    if (!account.stripePaymentMethodId) {
      res.status(400).json({
        error: "Payment method required. Create a checkout session first.",
      });
      return;
    }

    const [updated] = await db
      .update(billingAccounts)
      .set({
        topupAmountCents: topup_amount_cents,
        topupThresholdCents: topup_threshold_cents ?? 200,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.orgId, orgId))
      .returning();

    const usageCents = await fetchUsageOr502(orgId, userId, runId, wfHeaders, res);
    if (usageCents === null) return;

    res.json(buildAccountResponse(updated, usageCents));
  } catch (err) {
    console.error("[billing-service] Error updating auto-topup:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /v1/accounts/auto_topup — disable auto-topup
router.delete("/v1/accounts/auto_topup", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));

    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    if (!account) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }

    const [updated] = await db
      .update(billingAccounts)
      .set({
        topupAmountCents: null,
        topupThresholdCents: null,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.orgId, orgId))
      .returning();

    const usageCents = await fetchUsageOr502(orgId, userId, runId, wfHeaders, res);
    if (usageCents === null) return;

    res.json(buildAccountResponse(updated, usageCents));
  } catch (err) {
    console.error("[billing-service] Error disabling auto-topup:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
