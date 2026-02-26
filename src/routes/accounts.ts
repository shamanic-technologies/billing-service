import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { requireOrgHeaders } from "../middleware/auth.js";
import {
  UpdateModeRequestSchema,
  BillingModeSchema,
} from "../schemas.js";
import {
  createCustomer,
  createBalanceTransaction,
  listBalanceTransactions,
} from "../lib/stripe.js";

const router = Router();

function formatAccount(account: typeof billingAccounts.$inferSelect) {
  return {
    id: account.id,
    orgId: account.orgId,
    billingMode: account.billingMode,
    creditBalanceCents: account.creditBalanceCents,
    reloadAmountCents: account.reloadAmountCents,
    reloadThresholdCents: account.reloadThresholdCents,
    hasPaymentMethod: !!account.stripePaymentMethodId,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

// GET /v1/accounts — get or auto-create billing account
router.get("/v1/accounts", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;

    // Try to find existing account
    const existing = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    if (existing.length > 0) {
      res.json(formatAccount(existing[0]));
      return;
    }

    // Auto-create: Stripe customer + $2 trial credit
    const stripeCustomer = await createCustomer(orgId);

    // Credit $2 (negative amount = credit in Stripe)
    await createBalanceTransaction(
      stripeCustomer.id,
      -200,
      "Trial credit: $2.00"
    );

    // Insert with ON CONFLICT for race condition safety
    const [account] = await db
      .insert(billingAccounts)
      .values({
        orgId,
        stripeCustomerId: stripeCustomer.id,
        billingMode: "trial",
        creditBalanceCents: 200,
      })
      .onConflictDoNothing({ target: billingAccounts.orgId })
      .returning();

    // If conflict (another request created it), re-fetch
    if (!account) {
      const [refetched] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId))
        .limit(1);
      res.json(formatAccount(refetched));
      return;
    }

    res.json(formatAccount(account));
  } catch (err) {
    console.error("Error getting/creating account:", err);
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
      billing_mode: account.billingMode,
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

      const result = await listBalanceTransactions(account.stripeCustomerId);

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
  // Positive amount = deduction (customer owes more)
  // Negative amount = credit (customer gets credit)
  return amount > 0 ? "deduction" : "credit";
}

// PATCH /v1/accounts/mode — switch billing mode
router.patch("/v1/accounts/mode", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const parsed = UpdateModeRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { mode, reload_amount_cents } = parsed.data;

    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    if (!account) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }

    // Validate transitions
    // Note: Zod schema already restricts mode to "byok" | "payg" (trial is rejected at parse)

    // PAYG requires payment method
    if (mode === "payg") {
      if (!account.stripePaymentMethodId) {
        res.status(400).json({
          error:
            "Payment method required for PAYG. Create a checkout session first.",
        });
        return;
      }
      if (!reload_amount_cents) {
        res.status(400).json({
          error: "reload_amount_cents is required for PAYG mode",
        });
        return;
      }
    }

    const updateData: Record<string, unknown> = {
      billingMode: mode,
      updatedAt: new Date(),
    };

    if (mode === "payg" && reload_amount_cents) {
      updateData.reloadAmountCents = reload_amount_cents;
    }

    const [updated] = await db
      .update(billingAccounts)
      .set(updateData)
      .where(eq(billingAccounts.orgId, orgId))
      .returning();

    res.json(formatAccount(updated));
  } catch (err) {
    console.error("Error updating mode:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
