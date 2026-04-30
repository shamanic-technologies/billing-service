import { Router } from "express";
import { eq, sql as rawSql, and } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  creditLedger,
} from "../db/schema.js";
import {
  requireOrgHeaders,
  getWorkflowHeaders,
  forwardWorkflowHeaders,
} from "../middleware/auth.js";
import { RedeemPromoRequestSchema } from "../schemas.js";
import { findOrCreateAccount } from "../lib/account.js";
import { fireAndForgetBalanceTxn } from "../lib/ledger.js";

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

    // Check max redemptions (count from credit_ledger where source='promo')
    if (promo.maxRedemptions !== null) {
      const [countResult] = await db
        .select({ count: rawSql<number>`count(*)::int` })
        .from(creditLedger)
        .where(
          and(
            eq(creditLedger.promoCodeId, promo.id),
            eq(creditLedger.source, "promo")
          )
        );
      if (countResult.count >= promo.maxRedemptions) {
        res.status(400).json({ error: "Promo code has reached its redemption limit" });
        return;
      }
    }

    // Check if this org already redeemed this code (via credit_ledger)
    const [existing] = await db
      .select()
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.promoCodeId, promo.id),
          eq(creditLedger.orgId, orgId),
          eq(creditLedger.source, "promo")
        )
      )
      .limit(1);

    if (existing) {
      res.status(409).json({ error: "Promo code already redeemed by this organization" });
      return;
    }

    // Ensure billing account exists
    const account = await findOrCreateAccount(orgId, userId, wfHeaders);

    // Credit the promo amount inside a transaction
    const result = await db.transaction(async (tx) => {
      // Record the redemption in credit_ledger (partial unique index prevents double-dip)
      const [ledgerEntry] = await tx
        .insert(creditLedger)
        .values({
          orgId,
          userId,
          type: "credit",
          amountCents: promo.amountCents,
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
          creditBalanceCents: rawSql`${billingAccounts.creditBalanceCents} + ${promo.amountCents}`,
          updatedAt: new Date(),
        })
        .where(eq(billingAccounts.orgId, orgId))
        .returning();

      return { updated, ledgerEntryId: ledgerEntry.id };
    });

    // Fire-and-forget Stripe balance txn for promo credit
    if (account.stripeCustomerId) {
      fireAndForgetBalanceTxn(
        orgId,
        userId,
        account.stripeCustomerId,
        -promo.amountCents,
        `Promo credit: ${code} ($${(promo.amountCents / 100).toFixed(2)})`,
        result.ledgerEntryId,
        wfHeaders
      );
    }

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
      (err.message.includes("idx_credit_ledger_promo_org") ||
        err.message.includes("idx_promo_redemptions_org_code"))
    ) {
      res.status(409).json({ error: "Promo code already redeemed by this organization" });
      return;
    }
    console.error("[billing-service] Error redeeming promo:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
