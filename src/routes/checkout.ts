import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { requireOrgHeaders } from "../middleware/auth.js";
import { CreateCheckoutRequestSchema } from "../schemas.js";
import { createCustomer, createCheckoutSession } from "../lib/stripe.js";

const router = Router();

// POST /v1/checkout-sessions — create Stripe Checkout session for PAYG
router.post("/v1/checkout-sessions", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const parsed = CreateCheckoutRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { success_url, cancel_url, reload_amount_cents } = parsed.data;

    // Get or create billing account
    let [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    if (!account) {
      // Auto-create account with Stripe customer
      const stripeCustomer = await createCustomer(orgId);

      const [created] = await db
        .insert(billingAccounts)
        .values({
          orgId,
          stripeCustomerId: stripeCustomer.id,
          billingMode: "trial",
          creditBalanceCents: 200,
        })
        .onConflictDoNothing({ target: billingAccounts.orgId })
        .returning();

      account = created || (await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId))
        .limit(1)
      )[0];
    }

    if (!account.stripeCustomerId) {
      // Account exists but no Stripe customer — create one
      const stripeCustomer = await createCustomer(orgId);
      [account] = await db
        .update(billingAccounts)
        .set({
          stripeCustomerId: stripeCustomer.id,
          updatedAt: new Date(),
        })
        .where(eq(billingAccounts.orgId, orgId))
        .returning();
    }

    const session = await createCheckoutSession(
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
      .where(eq(billingAccounts.orgId, orgId));

    res.json({
      url: session.url,
      session_id: session.id,
    });
  } catch (err) {
    console.error("Error creating checkout session:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
