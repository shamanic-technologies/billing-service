/**
 * MAX BUDGET + MAX VOLUME per brand x offer x SALES FUNNEL (owner 2026-10-10).
 * Store, serve, measure: lib/sales-funnel-caps.ts. campaign-service reads the
 * internal GET to stop a funnel's pipes; the dashboard reads and writes the /v1
 * routes through the api-service gateway.
 *
 * Additive: the per-campaign ceilings (brand_budgets.ts, campaign_item_budgets.ts)
 * are untouched and keep serving their readers until both consumers move.
 */

import type { Request, Response } from "express";
import { Router } from "express";
import { requireOrgHeaders } from "../middleware/auth.js";
import { InternalSetSalesFunnelCapsRequestSchema, SetSalesFunnelCapsRequestSchema } from "../schemas.js";
import { parseNonNegativeCents } from "../lib/cents.js";
import {
  composeSalesFunnelCapsView,
  listBrandSalesFunnelCaps,
  setSalesFunnelCaps,
  statedCapsOf,
  SalesFunnelCatalogueUnavailableError,
  SalesFunnelNotFoundError,
  FunnelConversionRefusedError,
  type CapPeriod,
  type FunnelCapKey,
  type ReplacedCeilingKey,
} from "../lib/sales-funnel-caps.js";
import { getSalesFunnel, volumeUnitOf } from "../lib/sales-funnel-catalogue.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** features-service funnel ids are leg keys, `@`, `+`, channel slugs. Opaque, bounded. */
const MAX_BUDGET_INT_DIGITS = 12;
const FUNNEL_ID_RE = /^[A-Za-z0-9_@+\-.:|]{1,1000}$/;

function internalOrgId(req: Request, res: Response): string | null {
  const orgId = req.headers["x-org-id"] as string | undefined;
  if (!orgId || !UUID_RE.test(orgId)) {
    console.error(`[billing-service] [billing-400] ${req.method} ${req.path}: missing or invalid x-org-id`);
    res.status(400).json({ error: "x-org-id header is required and must be a valid UUID" });
    return null;
  }
  return orgId;
}

function keyOf(req: Request, res: Response, orgId: string): FunnelCapKey | null {
  const { brandId, offerId, salesFunnelId } = req.params;
  if (!UUID_RE.test(brandId) || !UUID_RE.test(offerId)) {
    res.status(400).json({ error: "brandId and offerId must be valid UUIDs" });
    return null;
  }
  if (!FUNNEL_ID_RE.test(salesFunnelId)) {
    res.status(400).json({ error: "salesFunnelId must be a features-service sales funnel id" });
    return null;
  }
  return { orgId, brandId, offerId, salesFunnelId };
}

/** Express 4 does not catch a rejected async handler: answer 500, loudly. */
const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response): void => {
    fn(req, res).catch((err) => {
      console.error(`[billing-service] ${req.method} ${req.path} failed:`, err);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    });
  };

const FUNNEL_PATH = "/brands/:brandId/offers/:offerId/sales-funnels/:salesFunnelId/caps";

router.get(`/internal${FUNNEL_PATH}`, handle(async (req, res) => {
  const orgId = internalOrgId(req, res);
  if (!orgId) return;
  const key = keyOf(req, res, orgId);
  if (!key) return;
  res.json(await composeSalesFunnelCapsView(key));
}));

router.get(`/v1${FUNNEL_PATH}`, requireOrgHeaders, handle(async (req, res) => {
  const key = keyOf(req, res, req.headers["x-org-id"] as string);
  if (!key) return;
  res.json(await composeSalesFunnelCapsView(key));
}));

/**
 * State a funnel's caps. The user writes through `/v1` (org headers); campaign-
 * service writes through `/internal` with its service identity (x-api-key +
 * x-org-id, x-user-id optional) and may name `replacesCeilings`: the pre-funnel
 * campaigns whose per-campaign ceilings this cap replaces (a conversion, refused
 * with 409 when it would move the brand's money beyond rounding).
 */
async function putCaps(req: Request, res: Response, key: FunnelCapKey, internal: boolean) {
  const parsed = (internal ? InternalSetSalesFunnelCapsRequestSchema : SetSalesFunnelCapsRequestSchema).safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({ error: `${issue.path.join(".") || "body"}: ${issue.message}` });
    return;
  }
  const body = parsed.data as { maxBudget: { amountCents: string | number; period: CapPeriod } | null; maxVolume: { count: number; period: CapPeriod } | null; replacesCeilings?: ReplacedCeilingKey[] };
  let amountCents: string | null = null;
  if (body.maxBudget) {
    try {
      amountCents = parseNonNegativeCents(body.maxBudget.amountCents);
      // numeric(22,10): 12 integer digits of cents (migration 0079).
      if (amountCents.split(".")[0].length > MAX_BUDGET_INT_DIGITS) {
        throw new Error(`must be below ${"1" + "0".repeat(MAX_BUDGET_INT_DIGITS)} cents`);
      }
    } catch (err) {
      res.status(400).json({ error: `maxBudget.amountCents: ${(err as Error).message}` });
      return;
    }
  }
  const userId = req.headers["x-user-id"] as string | undefined;
  if (userId !== undefined && !UUID_RE.test(userId)) {
    res.status(400).json({ error: "x-user-id must be a valid UUID" });
    return;
  }
  // Only a funnel features-service knows can be capped.
  try {
    await getSalesFunnel(key.salesFunnelId);
  } catch (err) {
    if (err instanceof SalesFunnelNotFoundError) {
      res.status(404).json({ error: err.message, reason: "sales_funnel_not_found" });
      return;
    }
    if (err instanceof SalesFunnelCatalogueUnavailableError) {
      console.error(`[billing-service] PUT sales funnel caps refused: ${err.message}`);
      res.status(502).json({ error: err.message, reason: "sales_funnel_catalogue_unavailable" });
      return;
    }
    throw err;
  }
  let conversion = null;
  try {
    ({ conversion } = await setSalesFunnelCaps(
      key,
      {
        maxBudget: body.maxBudget ? { amountCents: amountCents!, period: body.maxBudget.period } : null,
        maxVolume: body.maxVolume,
      },
      userId ?? null,
      new Date(),
      body.replacesCeilings && body.replacesCeilings.length > 0 ? body.replacesCeilings : null
    ));
  } catch (err) {
    if (err instanceof FunnelConversionRefusedError) {
      res.status(409).json({ error: err.message, reason: err.reason, ...err.detail });
      return;
    }
    throw err;
  }
  const view = await composeSalesFunnelCapsView(key);
  res.json(internal ? { ...view, conversion } : view);
}

router.put(`/v1${FUNNEL_PATH}`, requireOrgHeaders, handle(async (req, res) => {
  const key = keyOf(req, res, req.headers["x-org-id"] as string);
  if (!key) return;
  await putCaps(req, res, key, false);
}));

router.put(`/internal${FUNNEL_PATH}`, handle(async (req, res) => {
  const orgId = internalOrgId(req, res);
  if (!orgId) return;
  const key = keyOf(req, res, orgId);
  if (!key) return;
  await putCaps(req, res, key, true);
}));

router.delete(`/v1${FUNNEL_PATH}`, requireOrgHeaders, handle(async (req, res) => {
  const key = keyOf(req, res, req.headers["x-org-id"] as string);
  if (!key) return;
  await setSalesFunnelCaps(key, { maxBudget: null, maxVolume: null }, (req.headers["x-user-id"] as string) ?? null);
  res.json(await composeSalesFunnelCapsView(key));
}));

async function respondBrandList(req: Request, res: Response, orgId: string) {
  const { brandId } = req.params;
  if (!UUID_RE.test(brandId)) {
    res.status(400).json({ error: "brandId must be a valid UUID" });
    return;
  }
  const offerId = req.query.offerId;
  if (offerId !== undefined && (typeof offerId !== "string" || !UUID_RE.test(offerId))) {
    res.status(400).json({ error: "offerId must be a valid UUID" });
    return;
  }
  const rows = await listBrandSalesFunnelCaps(orgId, brandId, (offerId as string | undefined) ?? null);
  const caps = await Promise.all(
    rows.map(async (row) => {
      if (row.maxVolume == null) return statedCapsOf(row);
      try {
        return statedCapsOf(row, await volumeUnitOf(await getSalesFunnel(row.salesFunnelId)));
      } catch (err) {
        console.error(`[billing-service] volume unit of ${row.salesFunnelId} unreadable for the brand list: ${(err as Error).message}`);
        return statedCapsOf(row);
      }
    })
  );
  res.json({ orgId, brandId, caps });
}

router.get("/internal/brands/:brandId/sales-funnel-caps", handle(async (req, res) => {
  const orgId = internalOrgId(req, res);
  if (!orgId) return;
  await respondBrandList(req, res, orgId);
}));

router.get("/v1/brands/:brandId/sales-funnel-caps", requireOrgHeaders, handle(async (req, res) => {
  await respondBrandList(req, res, req.headers["x-org-id"] as string);
}));

export default router;
