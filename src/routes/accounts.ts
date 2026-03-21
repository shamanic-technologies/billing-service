import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { UpdateAutoReloadRequestSchema } from "../schemas.js";
import {
  createCustomer,
  createBalanceTransaction,
  listBalanceTransactions,
  isStripeAuthError,
} from "../lib/stripe.js";
import { findOrCreateAccount } from "../lib/account.js";

const router = Router();

function formatAccount(account: typeof billingAccounts.$inferSelect) {
  return {
    id: account.id,
    orgId: account.orgId,
    creditBalanceCents: account.creditBalanceCents,
    reloadAmountCents: account.reloadAmountCents,
    reloadThresholdCents: account.reloadThresholdCents,
    hasPaymentMethod: !!account.stripePaymentMethodId,
    hasAutoReload: !!(account.reloadAmountCents && account.stripePaymentMethodId),
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

// GET /v1/accounts — get or auto-create billing account
router.get("/v1/accounts", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));

    const account = await findOrCreateAccount(orgId, userId, wfHeaders);
    res.json(formatAccount(account));
  } catch (err) {
    console.error("Error getting/creating account:", err);
    if (isStripeAuthError(err)) {
      res.status(502).json({ error: "Payment provider authentication failed" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /v1/accounts/balance — fast balance check from DB
router.get("/v1/accounts/balance", requireOrgHeaders, async (req, res) => {
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

    res.json({
      balance_cents: account.creditBalanceCents,
      depleted: account.creditBalanceCents <= 0,
    });
  } catch (err) {
    console.error("Error checking balance:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /v1/accounts/transactions — proxy to Stripe balance transactions
router.get(
  "/v1/accounts/transactions",
  requireOrgHeaders,
  async (req, res) => {
    try {
      const orgId = req.headers["x-org-id"] as string;
      const userId = req.headers["x-user-id"] as string;
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

      if (!account.stripeCustomerId) {
        res.json({ transactions: [], has_more: false });
        return;
      }

      const result = await listBalanceTransactions(orgId, userId, account.stripeCustomerId, 50, wfHeaders);

      const transactions = result.data.map((txn) => ({
        id: txn.id,
        amount_cents: txn.amount,
        description: txn.description,
        created_at: new Date(txn.created * 1000).toISOString(),
        type: classifyTransaction(txn.amount, txn.description),
      }));

      res.json({ transactions, has_more: result.has_more });
    } catch (err) {
      console.error("Error listing transactions:", err);
      if (isStripeAuthError(err)) {
        res.status(502).json({ error: "Payment provider authentication failed" });
        return;
      }
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

function classifyTransaction(
  amount: number,
  description: string | null
): "deduction" | "credit" | "reload" {
  if (description?.includes("reload") || description?.includes("Reload")) {
    return "reload";
  }
  return amount > 0 ? "deduction" : "credit";
}

// PATCH /v1/accounts/auto-reload — configure auto-reload settings
router.patch("/v1/accounts/auto-reload", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const parsed = UpdateAutoReloadRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { reload_amount_cents, reload_threshold_cents } = parsed.data;

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
        reloadAmountCents: reload_amount_cents,
        reloadThresholdCents: reload_threshold_cents ?? 200,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.orgId, orgId))
      .returning();

    res.json(formatAccount(updated));
  } catch (err) {
    console.error("Error updating auto-reload:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /v1/accounts/auto-reload — disable auto-reload
router.delete("/v1/accounts/auto-reload", requireOrgHeaders, async (req, res) => {
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

    const [updated] = await db
      .update(billingAccounts)
      .set({
        reloadAmountCents: null,
        reloadThresholdCents: null,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.orgId, orgId))
      .returning();

    res.json(formatAccount(updated));
  } catch (err) {
    console.error("Error disabling auto-reload:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
