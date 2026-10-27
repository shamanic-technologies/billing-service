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
  composeSalesFunnelCampaignCapsView,
  composeSalesFunnelCapsView,
  listBrandSalesFunnelCaps,
  setSalesFunnelCaps,
  statedCapsOf,
  SalesFunnelCatalogueUnavailableError,
  SalesFunnelNotFoundError,
  type CapPeriod,
  type FunnelCapKey,
} from "../lib/sales-funnel-caps.js";
import { getSalesFunnel } from "../lib/sales-funnel-catalogue.js";
import { errorReason } from "../lib/pg-error.js";
import { deferStripeStepAlertOnCapWrite } from "../lib/stripe-step-alert.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * features-service funnel ids are leg keys, `@`, `+`, channel slugs, and `~<strategy id>`
 * after a pipe that runs a non-default PLAY (owner 2026-10-13, features-service v0.179.191:
 * `lead_found_to_conversation@sales-cold-email-outreach~valid-catch-all`). Opaque, bounded.
 */
const MAX_BUDGET_INT_DIGITS = 12;
const FUNNEL_ID_RE = /^[A-Za-z0-9_@+\-.:|~]{1,1000}$/;

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

/** The key of ONE funnel campaign's cap (campaign-service's funnel campaign id, a UUID). */
function campaignKeyOf(req: Request, res: Response, orgId: string): (FunnelCapKey & { salesFunnelCampaignId: string }) | null {
  const key = keyOf(req, res, orgId);
  if (!key) return null;
  const { salesFunnelCampaignId } = req.params;
  if (!UUID_RE.test(salesFunnelCampaignId)) {
    res.status(400).json({ error: "salesFunnelCampaignId must be a valid UUID" });
    return null;
  }
  return { ...key, salesFunnelCampaignId: salesFunnelCampaignId.toLowerCase() };
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
 * x-org-id, x-user-id optional). The pre-funnel ceiling CONVERSION
 * (`replacesCeilings`) was retired with the per-campaign ceilings (2026-10-14):
 * the body is strict, so a caller still naming it gets a 400.
 */
async function putCaps(req: Request, res: Response, key: FunnelCapKey, internal: boolean) {
  const parsed = (internal ? InternalSetSalesFunnelCapsRequestSchema : SetSalesFunnelCapsRequestSchema).safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({ error: `${issue.path.join(".") || "body"}: ${issue.message}` });
    return;
  }
  const body = parsed.data as { maxBudget: { amountCents: string | number; period: CapPeriod } | null; maxVolume: { count: number; period: CapPeriod } | null };
  let amountCents: string | null = null;
  if (body.maxBudget) {
    try {
      amountCents = parseNonNegativeCents(body.maxBudget.amountCents);
      // numeric(22,10): 12 integer digits of cents (migration 0079).
      if (amountCents.split(".")[0].length > MAX_BUDGET_INT_DIGITS) {
        throw new Error(`must be below ${"1" + "0".repeat(MAX_BUDGET_INT_DIGITS)} cents`);
      }
    } catch (err) {
      res.status(400).json({ error: `maxBudget.amountCents: ${errorReason(err)}` });
      return;
    }
  }
  const userId = req.headers["x-user-id"] as string | undefined;
  if (userId !== undefined && !UUID_RE.test(userId)) {
    res.status(400).json({ error: "x-user-id must be a valid UUID" });
    return;
  }
  // Only a funnel features-service knows can be capped; its served type is stored
  // with the caps (a reactive funnel's "Up to $X" counts 0 in daily figures).
  let salesFunnelType: "proactive" | "reactive" | null = null;
  try {
    salesFunnelType = (await getSalesFunnel(key.salesFunnelId)).type;
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
  await setSalesFunnelCaps(
    key,
    {
      maxBudget: body.maxBudget ? { amountCents: amountCents!, period: body.maxBudget.period } : null,
      maxVolume: body.maxVolume,
      salesFunnelType,
    },
    userId ?? null,
    new Date()
  );
  // A card-step owner ping still pending waits for this budget (lib/stripe-step-alert).
  await deferStripeStepAlertOnCapWrite(key.orgId);
  const view = key.salesFunnelCampaignId
    ? await composeSalesFunnelCampaignCapsView({ ...key, salesFunnelCampaignId: key.salesFunnelCampaignId })
    : await composeSalesFunnelCapsView(key);
  res.json(view);
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

/**
 * ONE sales funnel CAMPAIGN's caps (migration 0083): several funnel campaigns may
 * share one funnel (each naming different people); each may hold its own max
 * budget / max volume, consumed on its own units only. The read answers the cap
 * the campaign is HELD to: its own (`capScope: "sales_funnel_campaign"`), else
 * the funnel-wide one (`capScope: "sales_funnel"`). PUT/DELETE write the
 * campaign's own cap only; the funnel-wide routes above are unchanged.
 */
const CAMPAIGN_PATH = "/brands/:brandId/offers/:offerId/sales-funnels/:salesFunnelId/campaigns/:salesFunnelCampaignId/caps";

router.get(`/internal${CAMPAIGN_PATH}`, handle(async (req, res) => {
  const orgId = internalOrgId(req, res);
  if (!orgId) return;
  const key = campaignKeyOf(req, res, orgId);
  if (!key) return;
  res.json(await composeSalesFunnelCampaignCapsView(key));
}));

router.get(`/v1${CAMPAIGN_PATH}`, requireOrgHeaders, handle(async (req, res) => {
  const key = campaignKeyOf(req, res, req.headers["x-org-id"] as string);
  if (!key) return;
  res.json(await composeSalesFunnelCampaignCapsView(key));
}));

router.put(`/internal${CAMPAIGN_PATH}`, handle(async (req, res) => {
  const orgId = internalOrgId(req, res);
  if (!orgId) return;
  const key = campaignKeyOf(req, res, orgId);
  if (!key) return;
  await putCaps(req, res, key, true);
}));

router.put(`/v1${CAMPAIGN_PATH}`, requireOrgHeaders, handle(async (req, res) => {
  const key = campaignKeyOf(req, res, req.headers["x-org-id"] as string);
  if (!key) return;
  await putCaps(req, res, key, false);
}));

async function deleteCampaignCaps(req: Request, res: Response, key: FunnelCapKey & { salesFunnelCampaignId: string }) {
  await setSalesFunnelCaps(key, { maxBudget: null, maxVolume: null }, (req.headers["x-user-id"] as string) ?? null);
  res.json(await composeSalesFunnelCampaignCapsView(key));
}

router.delete(`/internal${CAMPAIGN_PATH}`, handle(async (req, res) => {
  const orgId = internalOrgId(req, res);
  if (!orgId) return;
  const key = campaignKeyOf(req, res, orgId);
  if (!key) return;
  await deleteCampaignCaps(req, res, key);
}));

router.delete(`/v1${CAMPAIGN_PATH}`, requireOrgHeaders, handle(async (req, res) => {
  const key = campaignKeyOf(req, res, req.headers["x-org-id"] as string);
  if (!key) return;
  await deleteCampaignCaps(req, res, key);
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
  res.json({ orgId, brandId, caps: await Promise.all(rows.map(statedCapsOf)) });
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
