import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { CreatePortalSessionRequestSchema } from "../schemas.js";
import { getCardSetup } from "../lib/stripe-service-client.js";
import {
  settleOutstandingBeforeCardChange,
  settlementWireFields,
} from "../lib/card-change-settlement.js";
import { ensureOrgStripeCustomer } from "../lib/account.js";

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
    const { return_url, amount, currency } = parsed.data;

    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    if (!account) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }

    // An outstanding balance is collected when the customer opens a card
    // session, and the outcome NEVER gates the session — see
    // lib/card-change-settlement for the full rule. Awaited rather than
    // fire-and-forget so a charge is not still in flight while the customer
    // detaches that same card in the acquirer's portal.
    //
    // The OUTCOME is reported beside the descriptor (additive), so the caller can
    // tell the customer before redirecting whether the balance was just charged,
    // was declined (and why, in the acquirer's own words), or was not attempted.
    const settlement = await settleOutstandingBeforeCardChange(orgId);

    // stripe-service 409s card setup for an org with no customer; a claimed org
    // that started anonymous has none yet, so create it (idempotently) first.
    await ensureOrgStripeCustomer({
      "x-org-id": orgId,
      "x-user-id": req.headers["x-user-id"] as string,
      ...forwardWorkflowHeaders(getWorkflowHeaders(req)),
    });

    const setup = await getCardSetup(orgId, return_url, amount, currency);
    res.json({ ...setup, ...settlementWireFields(settlement) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[billing-service] card setup failed:", message);
    res.status(502).json({ error: "Failed to start card setup" });
  }
});

export default router;
