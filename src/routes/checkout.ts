import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { requireOrgHeaders, getKeySourceInfo } from "../middleware/auth.js";
import { CreateCheckoutRequestSchema } from "../schemas.js";
import { createCustomer, createCheckoutSession, isStripeAuthError } from "../lib/stripe.js";

const router = Router();

// POST /v1/checkout-sessions — create Stripe Checkout session for PAYG
router.post("/v1/checkout-sessions", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const appId = req.headers["x-app-id"] as string;
    const keySourceInfo = getKeySourceInfo(req);
    const parsed = CreateCheckoutRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { success_url, cancel_url, reload_amount_cents } = parsed.data;
    const filter = and(eq(billingAccounts.orgId, orgId), eq(billingAccounts.appId, appId));

    // Get or create billing account
    let [account] = await db
      .select()
      .from(billingAccounts)
      .where(filter)
      .limit(1);

    if (!account) {
      // Auto-create account with Stripe customer
      const stripeCustomer = await createCustomer(keySourceInfo, orgId);

      const [created] = await db
        .insert(billingAccounts)
        .values({
          orgId,
          appId,
          stripeCustomerId: stripeCustomer.id,
          billingMode: "trial",
          creditBalanceCents: 200,
        })
        .onConflictDoNothing()
        .returning();

      account = created || (await db
        .select()
        .from(billingAccounts)
        .where(filter)
        .limit(1)
      )[0];
    }

    if (!account.stripeCustomerId) {
      // Account exists but no Stripe customer — create one
      const stripeCustomer = await createCustomer(keySourceInfo, orgId);
      [account] = await db
        .update(billingAccounts)
        .set({
          stripeCustomerId: stripeCustomer.id,
          updatedAt: new Date(),
        })
        .where(filter)
        .returning();
    }

    const session = await createCheckoutSession(
      keySourceInfo,
      account.stripeCustomerId!,
      success_url,
      cancel_url,
      reload_amount_cents
    );

    // Store the reload amount for when checkout completes
    await db
      .update(billingAccounts)
      .set({
        reloadAmountCents: reload_amount_cents,
        updatedAt: new Date(),
      })
      .where(filter);

    res.json({
      url: session.url,
      session_id: session.id,
    });
  } catch (err) {
    console.error("Error creating checkout session:", err);
    if (isStripeAuthError(err)) {
      res.status(502).json({ error: "Payment provider authentication failed" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
