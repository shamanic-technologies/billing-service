import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { CreatePortalSessionRequestSchema } from "../schemas.js";
import { getCardSetup } from "../lib/stripe-service-client.js";

const router = Router();

// POST /v1/portal-sessions — how this org's customer adds a card.
//
// The name is historical: it no longer always produces a "portal session",
// because not every acquirer has a portal. stripe-service resolves which
// acquirer holds the org's card and describes the mechanism — a hosted redirect
// for one, an embedded widget for another. This repo passes that through
// without interpreting it and without naming a vendor.
//
// Backwards compatible on purpose: the hosted case still carries `url` exactly
// where it always was, so a client that only reads `url` keeps working and can
// adopt `mode` whenever it likes.
router.post("/v1/portal-sessions", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;

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

    const setup = await getCardSetup(orgId, return_url);
    res.json(setup);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[billing-service] card setup failed:", message);
    res.status(502).json({ error: "Failed to start card setup" });
  }
});

export default router;
