import { Router } from "express";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, transactions as creditGrants } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { UpdateAutoReloadRequestSchema } from "../schemas.js";
import { isStripeAuthError } from "../lib/stripe.js";
import { findOrCreateAccount } from "../lib/account.js";
import { isDepleted, subCents } from "../lib/cents.js";
import { fetchRunsOrgUsageTotal } from "../lib/runs-client.js";

const router = Router();

function buildAccountResponse(
  account: typeof billingAccounts.$inferSelect,
  spentCents: string
) {
  return {
    id: account.id,
    orgId: account.orgId,
    grantsCents: account.creditBalanceCents,
    runsSpentCents: spentCents,
    availableCents: subCents(account.creditBalanceCents, spentCents),
    reloadAmountCents: account.reloadAmountCents,
    reloadThresholdCents: account.reloadThresholdCents,
    hasPaymentMethod: !!account.stripePaymentMethodId,
    hasAutoReload: !!(account.reloadAmountCents && account.stripePaymentMethodId),
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
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

// GET /v1/accounts/balance — fast balance check from DB
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
    const available = subCents(account.creditBalanceCents, usage.spent_cents);

    res.json({
      balance_cents: available,
      depleted: isDepleted(available),
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

// GET /v1/accounts/transactions — local billing-owned credit grant history
router.get(
  "/v1/accounts/transactions",
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

      // Exclude legacy `charge` rows (frozen post-#104; runs-service owns usage truth).
      const rows = await db
        .select()
        .from(creditGrants)
        .where(
          and(
            eq(creditGrants.orgId, orgId),
            ne(creditGrants.source, "charge")
          )
        )
        .orderBy(desc(creditGrants.createdAt))
        .limit(50);

      const transactions = rows.map((txn) => ({
        id: txn.id,
        amount_cents: txn.amountCents,
        description: txn.description,
        created_at: txn.createdAt.toISOString(),
        type: classifyTransaction(txn.source),
      }));

      res.json({ transactions, has_more: false });
    } catch (err) {
      console.error("[billing-service] Error listing transactions:", err);
      if (isStripeAuthError(err)) {
        res.status(502).json({ error: "Payment provider authentication failed" });
        return;
      }
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

function classifyTransaction(source: string): "credit" | "reload" {
  if (source === "reload") return "reload";
  return "credit";
}

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

// PATCH /v1/accounts/auto-reload — configure auto-reload settings
router.patch("/v1/accounts/auto-reload", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
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

    const spentCents = await fetchUsageOr502(orgId, userId, runId, wfHeaders, res);
    if (spentCents === null) return;

    res.json(buildAccountResponse(updated, spentCents));
  } catch (err) {
    console.error("[billing-service] Error updating auto-reload:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /v1/accounts/auto-reload — disable auto-reload
router.delete("/v1/accounts/auto-reload", requireOrgHeaders, async (req, res) => {
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
        reloadAmountCents: null,
        reloadThresholdCents: null,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.orgId, orgId))
      .returning();

    const spentCents = await fetchUsageOr502(orgId, userId, runId, wfHeaders, res);
    if (spentCents === null) return;

    res.json(buildAccountResponse(updated, spentCents));
  } catch (err) {
    console.error("[billing-service] Error disabling auto-reload:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
