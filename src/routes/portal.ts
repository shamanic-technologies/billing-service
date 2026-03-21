import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { CreatePortalSessionRequestSchema } from "../schemas.js";
import { createPortalSession, isStripeAuthError } from "../lib/stripe.js";

const router = Router();

// POST /v1/portal-sessions — create Stripe Customer Portal session
router.post("/v1/portal-sessions", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const parsed = CreatePortalSessionRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { return_url } = parsed.data;

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
      res.status(400).json({ error: "No Stripe customer associated with this account" });
      return;
    }

    const session = await createPortalSession(
      orgId,
      userId,
      account.stripeCustomerId,
      return_url,
      wfHeaders
    );

    res.json({ url: session.url });
  } catch (err) {
    console.error("Error creating portal session:", err);
    if (isStripeAuthError(err)) {
      res.status(502).json({ error: "Payment provider authentication failed" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
