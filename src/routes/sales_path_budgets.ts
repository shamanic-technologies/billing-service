/**
 * Sales-path ITEM budgets (lib/sales-path-items): the dashboard reads and states,
 * per brand x offer, one budget per (channel x leg) item of each sales path the
 * customer activated. campaign-service reads them through
 * GET /internal/brands/:brandId/sales-budget (mode "items").
 */
import type { Request, Response } from "express";
import { Router } from "express";
import { requireOrgHeaders } from "../middleware/auth.js";
import { SetSalesPathItemBudgetsRequestSchema } from "../schemas.js";
import {
  ItemBudgetRefused,
  getOfferItemsView,
  removePathItems,
  setPathItems,
} from "../lib/sales-path-items.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function view(orgId: string, brandId: string, offerId: string) {
  return { orgId, ...(await getOfferItemsView(orgId, brandId, offerId)) };
}

// GET /v1/brands/:brandId/offers/:offerId/sales-path-budgets — every active path's
// item budgets on this offer, with each item's minimum, cap and whether we run it.
router.get(
  "/v1/brands/:brandId/offers/:offerId/sales-path-budgets",
  requireOrgHeaders,
  async (req, res) => {
    const p = ids(req, res);
    if (!p) return;
    const orgId = req.headers["x-org-id"] as string;
    try {
      res.json(await view(orgId, p.brandId, p.offerId));
    } catch (err) {
      if (refuse(res, err)) return;
      throw err;
    }
  }
);

// PUT /v1/brands/:brandId/offers/:offerId/sales-path-budgets — state one path's
// item budgets. Body: { pathKey, items: [{featureSlug, legKey, budgetCents}], replacePathKey? }.
router.put(
  "/v1/brands/:brandId/offers/:offerId/sales-path-budgets",
  requireOrgHeaders,
  async (req, res) => {
    const p = ids(req, res);
    if (!p) return;
    const parsed = SetSalesPathItemBudgetsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        code: "invalid_items",
        details: parsed.error.flatten(),
      });
      return;
    }
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    try {
      const result = await setPathItems({
        orgId,
        brandId: p.brandId,
        offerId: p.offerId,
        pathKey: parsed.data.pathKey,
        items: parsed.data.items,
        replacePathKey: parsed.data.replacePathKey ?? null,
        userId,
      });
      res.json({ ...(await view(orgId, p.brandId, p.offerId)), ...result });
    } catch (err) {
      if (refuse(res, err)) return;
      throw err;
    }
  }
);

// DELETE /v1/brands/:brandId/offers/:offerId/sales-path-budgets?pathKey= — remove
// one path's item budgets (the path was deactivated). Idempotent.
router.delete(
  "/v1/brands/:brandId/offers/:offerId/sales-path-budgets",
  requireOrgHeaders,
  async (req, res) => {
    const p = ids(req, res);
    if (!p) return;
    const pathKey = typeof req.query.pathKey === "string" ? req.query.pathKey.trim() : "";
    if (!pathKey) {
      res.status(400).json({ error: "pathKey query parameter is required", code: "invalid_items" });
      return;
    }
    const orgId = req.headers["x-org-id"] as string;
    const removed = await removePathItems({
      orgId,
      brandId: p.brandId,
      offerId: p.offerId,
      pathKey,
      userId: req.headers["x-user-id"] as string,
    });
    try {
      res.json({ ...(await view(orgId, p.brandId, p.offerId)), removed });
    } catch (err) {
      if (refuse(res, err)) return;
      throw err;
    }
  }
);

// GET /internal/brands/:brandId/offers/:offerId/sales-path-budgets — same answer
// for a service (x-api-key + x-org-id).
router.get(
  "/internal/brands/:brandId/offers/:offerId/sales-path-budgets",
  async (req, res) => {
    const p = ids(req, res);
    if (!p) return;
    const orgId = req.headers["x-org-id"] as string | undefined;
    if (!orgId || !UUID_RE.test(orgId)) {
      res.status(400).json({ error: "x-org-id header must be a valid UUID" });
      return;
    }
    try {
      res.json(await view(orgId, p.brandId, p.offerId));
    } catch (err) {
      if (refuse(res, err)) return;
      throw err;
    }
  }
);

export default router;
