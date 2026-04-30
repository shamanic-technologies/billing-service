import { Router } from "express";
import { eq, and, isNull, gte, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, creditLedger } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { DeductRequestSchema, AuthorizeRequestSchema } from "../schemas.js";
import {
  createBalanceTransaction,
  chargePaymentMethod,
  listPaymentIntents,
  isStripeAuthError,
} from "../lib/stripe.js";
import { fireAndForgetBalanceTxn } from "../lib/ledger.js";
import { sendEmail } from "../lib/email-client.js";
import { resolveRequiredCents } from "../lib/costs-client.js";
import { findOrCreateAccount } from "../lib/account.js";

const router = Router();

/**
 * Compute the reload charge needed to cover `requiredCents` given `currentBalance`.
 * Returns the smallest multiple of `reloadUnit` such that balance + charge >= required.
 */
function computeReloadCharge(currentBalance: number, requiredCents: number, reloadUnit: number): number {
  const deficit = requiredCents - currentBalance;
  if (deficit <= 0) return 0;
  const multiples = Math.ceil(deficit / reloadUnit);
  return multiples * reloadUnit;
}

interface AccountRow {
  id: string;
  org_id: string;
  stripe_customer_id: string | null;
  credit_balance_cents: number;
  reload_amount_cents: number | null;
  reload_threshold_cents: number | null;
  stripe_payment_method_id: string | null;
}

/**
 * Reconcile the billing account against the ledger and Stripe.
 * Runs 3 self-healing checks before authorize checks sufficiency.
 */
async function reconcile(
  orgId: string,
  userId: string,
  account: AccountRow,
  wfHeaders: Record<string, string>
): Promise<void> {
  // Check 1: Cache vs Ledger
  // Only reconcile if ledger has entries — no entries means account predates ledger
  const [ledgerResult] = await db.execute<{ computed: number; entry_count: number }>(
    rawSql`SELECT COALESCE(SUM(
      CASE
        WHEN type = 'credit' AND status = 'confirmed' THEN amount_cents
        WHEN type = 'debit' AND status IN ('confirmed', 'pending') THEN -amount_cents
        ELSE 0
      END
    ), 0)::int AS computed,
    COUNT(*)::int AS entry_count
    FROM credit_ledger WHERE org_id = ${orgId}`
  );
  const { computed, entry_count } = ledgerResult as unknown as { computed: number; entry_count: number };
  if (entry_count > 0 && computed !== account.credit_balance_cents) {
    console.warn(
      `[billing-service] Cache drift detected for org ${orgId}: cache=${account.credit_balance_cents}, ledger=${computed}. Fixing.`
    );
    await db
      .update(billingAccounts)
      .set({ creditBalanceCents: computed, updatedAt: new Date() })
      .where(eq(billingAccounts.orgId, orgId));
  }

  // Check 2: Stripe payments -> DB
  if (account.stripe_customer_id) {
    try {
      const paymentIntents = await listPaymentIntents(
        orgId,
        userId,
        account.stripe_customer_id,
        wfHeaders
      );
      for (const pi of paymentIntents.data) {
        if (pi.status !== "succeeded") continue;
        const [existingEntry] = await db
          .select({ id: creditLedger.id })
          .from(creditLedger)
          .where(
            and(
              eq(creditLedger.orgId, orgId),
              eq(creditLedger.stripePaymentIntentId, pi.id),
              eq(creditLedger.source, "reload")
            )
          )
          .limit(1);
        if (!existingEntry) {
          console.warn(
            `[billing-service] Missing ledger entry for PI ${pi.id}, org ${orgId}. Recovering.`
          );
          await db.insert(creditLedger).values({
            orgId,
            userId,
            type: "credit",
            amountCents: pi.amount,
            status: "confirmed",
            source: "reload",
            stripePaymentIntentId: pi.id,
            description: `Recovered reload from Stripe PI ${pi.id}`,
          });
          await db
            .update(billingAccounts)
            .set({
              creditBalanceCents: rawSql`${billingAccounts.creditBalanceCents} + ${pi.amount}`,
              updatedAt: new Date(),
            })
            .where(eq(billingAccounts.orgId, orgId));
        }
      }
    } catch (err) {
      console.error("[billing-service] Check 2 failed (Stripe -> DB):", err);
    }
  }

  // Check 3: DB -> Stripe (synchronous — must succeed on reconcile path)
  if (account.stripe_customer_id) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const unsyncedEntries = await db
      .select()
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.orgId, orgId),
          isNull(creditLedger.stripeBalanceTxnId),
          eq(creditLedger.status, "confirmed"),
          gte(creditLedger.createdAt, sevenDaysAgo)
        )
      );

    for (const entry of unsyncedEntries) {
      try {
        const stripeAmount =
          entry.type === "credit" ? -entry.amountCents : entry.amountCents;
        const txn = await createBalanceTransaction(
          orgId,
          userId,
          account.stripe_customer_id,
          stripeAmount,
          entry.description ?? `Reconciled ${entry.source}`,
          undefined,
          wfHeaders
        );
        await db
          .update(creditLedger)
          .set({ stripeBalanceTxnId: txn.id, updatedAt: new Date() })
          .where(eq(creditLedger.id, entry.id));
      } catch (err) {
        console.error(
          `[billing-service] Check 3: Failed to sync ledger entry ${entry.id} to Stripe:`,
          err
        );
      }
    }
  }
}

// POST /v1/credits/deduct — deduct credits from org balance (allows negative balances)
router.post("/v1/credits/deduct", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const parsed = DeductRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { amount_cents, description } = parsed.data;

    // Ensure account exists (auto-create with $2 trial credit if new)
    await findOrCreateAccount(orgId, userId, wfHeaders);

    // Use Drizzle transaction with FOR UPDATE lock to prevent double-spend
    const result = await db.transaction(async (tx) => {
      const rows = await tx.execute<AccountRow>(
        rawSql`SELECT * FROM billing_accounts WHERE org_id = ${orgId} FOR UPDATE`
      );

      const account = (rows as unknown as AccountRow[])[0];
      if (!account) {
        return { error: "Billing account not found" as const, status: 404 as const };
      }

      // Always deduct, even if it results in a negative balance
      const newBalance = account.credit_balance_cents - amount_cents;
      await tx
        .update(billingAccounts)
        .set({
          creditBalanceCents: newBalance,
          updatedAt: new Date(),
        })
        .where(eq(billingAccounts.orgId, orgId));

      // Insert debit ledger entry
      const [ledgerEntry] = await tx
        .insert(creditLedger)
        .values({
          orgId,
          userId,
          runId,
          type: "debit",
          amountCents: amount_cents,
          status: "confirmed",
          source: "deduct",
          description,
        })
        .returning();

      return {
        success: true as const,
        balance_cents: newBalance,
        depleted: newBalance <= 0,
        _customerId: account.stripe_customer_id,
        _ledgerEntryId: ledgerEntry.id,
      };
    });

    if ("error" in result && result.error) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }

    // Fire-and-forget Stripe balance transaction
    if (result._customerId && result._ledgerEntryId) {
      fireAndForgetBalanceTxn(
        orgId,
        userId,
        result._customerId,
        amount_cents,
        description,
        result._ledgerEntryId,
        wfHeaders
      );
    }

    // Send depleted email if needed
    if (result.depleted) {
      sendEmail({
        eventType: "credits-depleted",
        orgId,
        userId,
        runId,
        workflowHeaders: wfHeaders,
      });
    }

    // Strip internal fields from response
    const { _customerId: _c, _ledgerEntryId: _l, ...response } = result as Record<string, unknown>;
    res.json(response);
  } catch (err) {
    console.error("[billing-service] Error deducting credits:", err);
    if (isStripeAuthError(err)) {
      res.status(502).json({ error: "Payment provider authentication failed" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /v1/credits/authorize — synchronous pre-execution authorization with auto-reload attempt
// Resolves prices from costs-service, runs reconciliation, then checks balance.
router.post("/v1/credits/authorize", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const parsed = AuthorizeRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { items } = parsed.data;

    // Resolve prices from costs-service (outside transaction — read-only, no lock needed)
    let requiredCents: number;
    try {
      requiredCents = await resolveRequiredCents(items, {
        "x-org-id": orgId,
        "x-user-id": userId,
        "x-run-id": runId,
        ...wfHeaders,
      });
    } catch (costErr) {
      console.error("[billing-service] Failed to resolve prices from costs-service:", costErr);
      res.status(502).json({ error: "Failed to resolve prices from costs-service" });
      return;
    }

    // Ensure account exists (auto-create with $2 trial credit if new)
    await findOrCreateAccount(orgId, userId, wfHeaders);

    // Run reconciliation checks before checking sufficiency
    const [preAccount] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    if (preAccount) {
      await reconcile(
        orgId,
        userId,
        {
          id: preAccount.id,
          org_id: preAccount.orgId,
          stripe_customer_id: preAccount.stripeCustomerId,
          credit_balance_cents: preAccount.creditBalanceCents,
          reload_amount_cents: preAccount.reloadAmountCents,
          reload_threshold_cents: preAccount.reloadThresholdCents,
          stripe_payment_method_id: preAccount.stripePaymentMethodId,
        },
        wfHeaders
      );
    }

    const result = await db.transaction(async (tx) => {
      const rows = await tx.execute<AccountRow>(
        rawSql`SELECT * FROM billing_accounts WHERE org_id = ${orgId} FOR UPDATE`
      );

      const account = (rows as unknown as AccountRow[])[0];
      if (!account) {
        return { error: "Billing account not found" as const, status: 404 as const };
      }

      let currentBalance = account.credit_balance_cents;

      // If insufficient, try synchronous auto-reload (charge enough multiples to cover)
      let reloadLedgerEntryId: string | null = null;
      if (currentBalance < requiredCents) {
        if (
          account.stripe_payment_method_id &&
          account.stripe_customer_id &&
          account.reload_amount_cents
        ) {
          const chargeAmount = computeReloadCharge(currentBalance, requiredCents, account.reload_amount_cents);
          try {
            const pi = await chargePaymentMethod(
              orgId,
              userId,
              account.stripe_customer_id,
              account.stripe_payment_method_id,
              chargeAmount,
              `Auto-reload (${chargeAmount / account.reload_amount_cents}x)`,
              wfHeaders
            );

            // Insert reload ledger entry
            const [reloadEntry] = await tx
              .insert(creditLedger)
              .values({
                orgId,
                userId,
                type: "credit",
                amountCents: chargeAmount,
                status: "confirmed",
                source: "reload",
                stripePaymentIntentId: pi.id,
                description: `Auto-reload credit ($${(chargeAmount / 100).toFixed(2)})`,
              })
              .returning();
            reloadLedgerEntryId = reloadEntry.id;

            currentBalance += chargeAmount;
            await tx
              .update(billingAccounts)
              .set({
                creditBalanceCents: currentBalance,
                updatedAt: new Date(),
              })
              .where(eq(billingAccounts.orgId, orgId));
          } catch (reloadErr) {
            console.error("[billing-service] Auto-reload failed during authorize:", reloadErr);
            return {
              sufficient: false as const,
              balance_cents: currentBalance,
              required_cents: requiredCents,
              _emailEvent: "credits-reload-failed" as const,
              _reloadLedgerEntryId: null as string | null,
              _customerId: account.stripe_customer_id,
            };
          }
        }
      }

      const sufficient = currentBalance >= requiredCents;

      return {
        sufficient: sufficient as boolean,
        balance_cents: currentBalance,
        required_cents: requiredCents,
        _emailEvent: sufficient ? null : ("credits-depleted" as const),
        _reloadLedgerEntryId: reloadLedgerEntryId,
        _customerId: account.stripe_customer_id,
      };
    });

    if ("error" in result && result.error) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }

    // Fire-and-forget Stripe balance txn for the reload (if one happened)
    if (result._reloadLedgerEntryId && result._customerId) {
      const entry = await db
        .select()
        .from(creditLedger)
        .where(eq(creditLedger.id, result._reloadLedgerEntryId))
        .limit(1);
      if (entry[0]) {
        fireAndForgetBalanceTxn(
          orgId,
          userId,
          result._customerId,
          -entry[0].amountCents,
          entry[0].description ?? "Auto-reload credit",
          result._reloadLedgerEntryId,
          wfHeaders
        );
      }
    }

    // Fire-and-forget email notification
    const emailEvent = "_emailEvent" in result ? result._emailEvent : null;
    if (emailEvent) {
      sendEmail({
        eventType: emailEvent,
        orgId,
        userId,
        runId,
        workflowHeaders: wfHeaders,
      });
    }

    // Strip internal fields
    const { _emailEvent, _reloadLedgerEntryId, _customerId, ...response } = result as Record<string, unknown>;
    res.json(response);
  } catch (err) {
    console.error("[billing-service] Error authorizing credits:", err);
    if (isStripeAuthError(err)) {
      res.status(502).json({ error: "Payment provider authentication failed" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
