/**
 * Budgets PER CAMPAIGN (lib/campaign-items): the dashboard reads and states, per
 * brand x offer, one budget per campaign (offer x leg x channel), on the ONE store
 * per campaign (its ceiling row, shared with PUT /v1/brands/:id/campaign-budget).
 * campaign-service reads them through GET /internal/brands/:brandId/sales-budget
 * (mode "items"). On/off is campaign-service's campaign status, not stored here.
 */
import type { Request, Response } from "express";
import { Router } from "express";
import {
  ItemBudgetRefused,
  getOfferItemsView,
} from "../lib/campaign-items.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE = "/brands/:brandId/offers/:offerId/campaign-budgets";

function ids(req: Request, res: Response): { brandId: string; offerId: string } | null {
  const { brandId, offerId } = req.params;
  if (!UUID_RE.test(brandId) || !UUID_RE.test(offerId)) {
    res.status(400).json({ error: "brandId and offerId must be valid UUIDs", code: "invalid_ids" });
    return null;
  }
  return { brandId: brandId.toLowerCase(), offerId: offerId.toLowerCase() };
}

function refuse(res: Response, err: unknown): boolean {
  if (err instanceof ItemBudgetRefused) {
    res.status(err.status).json({ error: err.message, code: err.code, ...err.details });
    return true;
  }
  return false;
}

/** `?campaigns=featureSlug:legKey,featureSlug:legKey` — rows wanted even when not set. */
function campaignsQuery(req: Request): Array<{ featureSlug: string; legKey: string }> | null {
  const raw = req.query.campaigns;
  if (raw === undefined) return [];
  if (typeof raw !== "string") return null;
  const out: Array<{ featureSlug: string; legKey: string }> = [];
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const at = part.indexOf(":");
    if (at <= 0 || at === part.length - 1) return null;
    out.push({ featureSlug: part.slice(0, at), legKey: part.slice(at + 1) });
  }
  return out;
}

async function view(
  orgId: string,
  brandId: string,
  offerId: string,
  campaigns: Array<{ featureSlug: string; legKey: string }> = []
) {
  return { orgId, ...(await getOfferItemsView(orgId, brandId, offerId, campaigns)) };
}

async function read(req: Request, res: Response, orgId: string) {
  const p = ids(req, res);
  if (!p) return;
  const campaigns = campaignsQuery(req);
  if (!campaigns) {
    res.status(400).json({
      error: "campaigns must be a comma-separated list of featureSlug:legKey",
      code: "invalid_items",
    });
    return;
  }
  try {
    res.json(await view(orgId, p.brandId, p.offerId, campaigns));
  } catch (err) {
    if (refuse(res, err)) return;
    throw err;
  }
}

// GET /internal/brands/:brandId/offers/:offerId/campaign-budgets — same read for a
// service (x-api-key + x-org-id).
router.get(`/internal${BASE}`, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string | undefined;
  if (!orgId || !UUID_RE.test(orgId)) {
    res.status(400).json({ error: "x-org-id header must be a valid UUID" });
    return;
  }
  await read(req, res, orgId);
});

export default router;
