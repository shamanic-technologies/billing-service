import { Router } from "express";
import { eq, sql as rawSql, and } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  customerBalanceTransactions,
} from "../db/schema.js";
import {
  requireOrgHeaders,
  getWorkflowHeaders,
  forwardWorkflowHeaders,
} from "../middleware/auth.js";
import { RedeemPromotionCodeRequestSchema } from "../schemas.js";
import { findOrCreateAccount } from "../lib/account.js";
import { traceEvent } from "../lib/trace-event.js";

const router = Router();

// POST /v1/promotion_codes/redeem — redeem a promo code for bonus credits.
// Returns signed amount_cents (negative since credits decrement balance liability).
router.post("/v1/promotion_codes/redeem", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));

    const parsed = RedeemPromotionCodeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { code } = parsed.data;
    const runId = req.headers["x-run-id"] as string;

    traceEvent(runId, { service: "billing-service", event: "promotion_codes.redeem.start", data: { code } }, req.headers);

    const [promo] = await db
      .select()
      .from(localPromoCodes)
      .where(eq(localPromoCodes.code, code))
      .limit(1);

    if (!promo) {
      res.status(400).json({ error: "Invalid promo code" });
      return;
    }

    if (promo.expiresAt && promo.expiresAt < new Date()) {
      res.status(400).json({ error: "Promo code has expired" });
      return;
    }

    if (promo.maxRedemptions !== null) {
      const [countResult] = await db
        .select({ count: rawSql<number>`count(*)::int` })
        .from(customerBalanceTransactions)
        .where(
          and(
            eq(customerBalanceTransactions.promoCodeId, promo.id),
            eq(customerBalanceTransactions.type, "promo")
          )
        );
      if (countResult.count >= promo.maxRedemptions) {
        res.status(400).json({ error: "Promo code has reached its redemption limit" });
        return;
      }
    }

    const [existing] = await db
      .select()
      .from(customerBalanceTransactions)
      .where(
        and(
          eq(customerBalanceTransactions.promoCodeId, promo.id),
          eq(customerBalanceTransactions.orgId, orgId),
          eq(customerBalanceTransactions.type, "promo")
        )
      )
      .limit(1);

    if (existing) {
      res.status(409).json({ error: "Promo code already redeemed by this organization" });
      return;
    }

    await findOrCreateAccount(orgId, userId, wfHeaders);

    const result = await db.transaction(async (tx) => {
      const [accountBefore] = await tx
        .select({ balanceCents: billingAccounts.balanceCents })
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId))
        .limit(1);
      const oldBalance = accountBefore?.balanceCents ?? "0.0000000000";

      const [ledgerEntry] = await tx
        .insert(customerBalanceTransactions)
        .values({
          orgId,
          userId,
          type: "promo",
          // Signed: negative = credit. Promo redemption = credit.
          amountCents: String(-promo.amountCents),
          status: "succeeded",
          promoCodeId: promo.id,
          description: `Promo: ${code} ($${(promo.amountCents / 100).toFixed(2)})`,
        })
        .returning();

      const [updated] = await tx
        .update(billingAccounts)
        .set({
          balanceCents: rawSql`${billingAccounts.balanceCents} + ${promo.amountCents}::numeric`,
          updatedAt: new Date(),
        })
        .where(eq(billingAccounts.orgId, orgId))
        .returning();

      return { updated, ledgerEntryId: ledgerEntry.id, oldBalance };
    });

    traceEvent(runId, { service: "billing-service", event: "promotion_codes.redeem.done", data: { code, amount_cents: -promo.amountCents, balance_cents: result.updated.balanceCents } }, req.headers);

    console.log(
      `[billing-service] Promo "${code}" redeemed by org ${orgId}: +$${(promo.amountCents / 100).toFixed(2)}`
    );

    res.json({
      redeemed: true,
      // Signed amount on wire matches CBT convention.
      amount_cents: String(-promo.amountCents),
      balance_cents: result.updated.balanceCents,
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("idx_cbt_promo_org") ||
        err.message.includes("idx_transactions_promo_org"))
    ) {
      res.status(409).json({ error: "Promo code already redeemed by this organization" });
      return;
    }
    console.error("[billing-service] Error redeeming promo:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
