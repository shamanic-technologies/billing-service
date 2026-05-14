import { Router } from "express";
import { eq, sql as rawSql, and } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  transactions,
} from "../db/schema.js";
import {
  requireOrgHeaders,
  getWorkflowHeaders,
  forwardWorkflowHeaders,
} from "../middleware/auth.js";
import { RedeemPromoRequestSchema } from "../schemas.js";
import { findOrCreateAccount } from "../lib/account.js";
import { traceEvent } from "../lib/trace-event.js";

const router = Router();

// POST /v1/promo/redeem — redeem a promo code for bonus credits
router.post("/v1/promo/redeem", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));

    const parsed = RedeemPromoRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { code } = parsed.data;
    const runId = req.headers["x-run-id"] as string;

    traceEvent(runId, { service: "billing-service", event: "promo.redeem.start", data: { code } }, req.headers);

    // Look up the promo code
    const [promo] = await db
      .select()
      .from(localPromoCodes)
      .where(eq(localPromoCodes.code, code))
      .limit(1);

    if (!promo) {
      res.status(400).json({ error: "Invalid promo code" });
      return;
    }

    // Check expiration
    if (promo.expiresAt && promo.expiresAt < new Date()) {
      res.status(400).json({ error: "Promo code has expired" });
      return;
    }

    if (promo.maxRedemptions !== null) {
      const [countResult] = await db
        .select({ count: rawSql<number>`count(*)::int` })
        .from(transactions)
        .where(
          and(
            eq(transactions.promoCodeId, promo.id),
            eq(transactions.source, "promo")
          )
        );
      if (countResult.count >= promo.maxRedemptions) {
        res.status(400).json({ error: "Promo code has reached its redemption limit" });
        return;
      }
    }

    const [existing] = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.promoCodeId, promo.id),
          eq(transactions.orgId, orgId),
          eq(transactions.source, "promo")
        )
      )
      .limit(1);

    if (existing) {
      res.status(409).json({ error: "Promo code already redeemed by this organization" });
      return;
    }

    // Ensure billing account exists
    await findOrCreateAccount(orgId, userId, wfHeaders);

    // Credit the promo amount inside a transaction
    const result = await db.transaction(async (tx) => {
      const [accountBefore] = await tx
        .select({ creditBalanceCents: billingAccounts.creditBalanceCents })
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId))
        .limit(1);
      const oldBalance = accountBefore?.creditBalanceCents ?? "0.0000000000";

      const [ledgerEntry] = await tx
        .insert(transactions)
        .values({
          orgId,
          userId,
          type: "credit",
          amountCents: String(promo.amountCents),
          status: "confirmed",
          source: "promo",
          promoCodeId: promo.id,
          description: `Promo credit: ${code} ($${(promo.amountCents / 100).toFixed(2)})`,
        })
        .returning();

      // Credit the balance
      const [updated] = await tx
        .update(billingAccounts)
        .set({
          creditBalanceCents: rawSql`${billingAccounts.creditBalanceCents} + ${promo.amountCents}::numeric`,
          updatedAt: new Date(),
        })
        .where(eq(billingAccounts.orgId, orgId))
        .returning();

      return { updated, ledgerEntryId: ledgerEntry.id, oldBalance };
    });

    traceEvent(runId, { service: "billing-service", event: "promo.redeem.done", data: { code, amount_cents: promo.amountCents, balance_cents: result.updated.creditBalanceCents } }, req.headers);

    console.log(
      `[billing-service] Promo "${code}" redeemed by org ${orgId}: +$${(promo.amountCents / 100).toFixed(2)}`
    );

    res.json({
      redeemed: true,
      amount_cents: promo.amountCents,
      balance_cents: result.updated.creditBalanceCents,
    });
  } catch (err) {
    // Handle unique constraint violation (race condition double-dip via partial index)
    if (
      err instanceof Error &&
      err.message.includes("idx_transactions_promo_org")
    ) {
      res.status(409).json({ error: "Promo code already redeemed by this organization" });
      return;
    }
    console.error("[billing-service] Error redeeming promo:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
