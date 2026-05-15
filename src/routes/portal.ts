import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { CreatePortalSessionRequestSchema } from "../schemas.js";
import { createPortalSession } from "../lib/stripe-service-client.js";

const router = Router();

// POST /v1/portal-sessions — Stripe Customer Portal session via stripe-service.
router.post("/v1/portal-sessions", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
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

    let session;
    try {
      session = await createPortalSession(
        {
          "x-org-id": orgId,
          "x-user-id": userId,
          "x-run-id": runId,
          ...wfHeaders,
        },
        { return_url }
      );
    } catch (err) {
      console.error("[billing-service] stripe-service createPortalSession failed:", err);
      res.status(502).json({ error: "Failed to create portal session via stripe-service" });
      return;
    }

    res.json({ url: session.url });
  } catch (err) {
    console.error("[billing-service] Error creating portal session:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
