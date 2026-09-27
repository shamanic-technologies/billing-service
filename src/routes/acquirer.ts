import { Router } from "express";
import { requireOrgHeaders } from "../middleware/auth.js";
import { DeclareAcquirerRequestSchema } from "../schemas.js";
import { pinOrgAcquirer } from "../lib/stripe-service-client.js";

/**
 * PUT /v1/accounts/acquirer — the dashboard declares, right after creating an
 * org and before any card or payment, that this org pays through Revolut.
 *
 * A thin relay: the dashboard holds only billing's key, and stripe-service owns
 * the pin (it creates the acquirer-side customer and refuses a move that would
 * strand a chargeable card). Nothing here decides anything about acquirers; the
 * body schema only narrows WHAT the dashboard may declare to the one value it
 * needs, so this surface can never move an existing org back and forth.
 *
 * Deliberately touches no billing row: a billing account (and its welcome
 * decision) is still created by the org's first ordinary /v1 read, exactly as
 * for every other org.
 */
const router = Router();

router.put("/v1/accounts/acquirer", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  const parsed = DeclareAcquirerRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const pin = await pinOrgAcquirer(orgId, parsed.data);
    if (!pin.pinned) {
      res.status(409).json({ error: pin.error, code: "chargeable_card_on_other_acquirer" });
      return;
    }
    res.json({ org_id: orgId, acquirer: pin.acquirer });
  } catch (err) {
    console.error(`[billing-service] acquirer declaration failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to declare the org's acquirer via stripe-service" });
  }
});

export default router;
