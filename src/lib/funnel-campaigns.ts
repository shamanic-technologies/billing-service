/**
 * SALES FUNNEL CAMPAIGNS in billing's budget-derived figures (owner 2026-10-10).
 *
 * campaign-service (v0.75.15) runs a campaign as brand x offer x SALES FUNNEL: one
 * funnel campaign owning one UNIT (an ordinary `campaigns` row) per pipe
 * (`GET /sales-funnel-campaigns`, units `{campaignId, featureSlug, legKey, status}`).
 * A unit has NO per-pipe budget: its money is the funnel's MAX BUDGET
 * (lib/sales-funnel-caps.ts). So every billing figure derived from campaign
 * budgets counts a funnel campaign by that cap, and never resolves a unit onto a
 * per-(offer, leg, channel) ceiling (a legacy ceiling on the same pipe would be
 * attributed to it and counted twice or wrongly).
 *
 * The figures are DAILY (brand daily budget, payment-outlook configured/running,
 * revenue DRR -> MRR = DRR x 30 -> ARR). A cap's period is normalised to a day:
 * daily x1, weekly / 7, monthly / 30 (MRR_DAYS: a monthly cap reads back as its
 * own amount in MRR). A ONE-OFF cap is not recurring: it adds nothing to a daily
 * figure. No discount: a cap is configuration.
 */

import { Decimal } from "decimal.js";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { salesFunnelCaps, type SalesFunnelCapRow } from "../db/schema.js";
import { fetchWithRetry } from "./fetch-retry.js";
import type { RecurringStatusUnavailableReason } from "./campaign-service-client.js";

const DAYS_PER = { daily: 1, weekly: 7, monthly: 30 } as const;
const TIMEOUT_MS = 10_000;

/** One unit of a funnel campaign: the `campaigns` row running one pipe. */
export interface SalesFunnelUnit {
  campaignId: string;
  featureSlug: string;
  legKey: string;
  status: string;
}

export interface SalesFunnelCampaign {
  id: string;
  brandId: string;
  offerId: string;
  salesFunnelId: string;
  /** features-service's name of the funnel, as campaign-service stored it; null when absent. */
  salesFunnelName?: string | null;
  status: string;
  units: SalesFunnelUnit[];
}

export type SalesFunnelCampaignsAnswer =
  | { ok: true; campaigns: SalesFunnelCampaign[] }
  | { ok: false; reason: RecurringStatusUnavailableReason };

/**
 * PURE: a cap's budget as a DAILY recurring amount. null = no budget stated;
 * "0" for a one_off cap (not recurring).
 */
export function recurringDailyCentsOf(
  cap: Pick<SalesFunnelCapRow, "maxBudgetCents" | "maxBudgetPeriod"> | null | undefined
): string | null {
  if (!cap || cap.maxBudgetCents == null || cap.maxBudgetPeriod == null) return null;
  if (cap.maxBudgetPeriod === "one_off") return new Decimal(0).toFixed(10);
  const days = DAYS_PER[cap.maxBudgetPeriod as keyof typeof DAYS_PER];
  if (!days) throw new Error(`unknown sales funnel cap period ${cap.maxBudgetPeriod}`);
  return new Decimal(cap.maxBudgetCents).dividedBy(days).toFixed(10);
}

/** Every cap of an org (optionally one brand) that states a budget. */
export async function funnelBudgetCaps(orgId: string, brandId?: string): Promise<SalesFunnelCapRow[]> {
  const where = brandId
    ? and(eq(salesFunnelCaps.orgId, orgId), eq(salesFunnelCaps.brandId, brandId), isNotNull(salesFunnelCaps.maxBudgetCents))
    : and(eq(salesFunnelCaps.orgId, orgId), isNotNull(salesFunnelCaps.maxBudgetCents));
  return db.select().from(salesFunnelCaps).where(where);
}

/** PURE: the brand's configured recurring daily funnel budget, or null when no cap recurs. */
export function brandFunnelDailyCents(caps: SalesFunnelCapRow[]): string | null {
  const recurring = caps.filter((c) => c.maxBudgetPeriod !== "one_off" && c.maxBudgetCents != null);
  if (recurring.length === 0) return null;
  return recurring.reduce((s, c) => s.plus(recurringDailyCentsOf(c)!), new Decimal(0)).toFixed(10);
}

/** The cap of a funnel campaign (same org, brand, offer, funnel), or null. */
export function capOfFunnelCampaign(
  caps: SalesFunnelCapRow[],
  fc: Pick<SalesFunnelCampaign, "brandId" | "offerId" | "salesFunnelId">
): SalesFunnelCapRow | null {
  return (
    caps.find((c) => c.brandId === fc.brandId && c.offerId === fc.offerId && c.salesFunnelId === fc.salesFunnelId) ??
    null
  );
}

/**
 * The org's funnel campaigns and their units, from campaign-service.
 * Fail-soft with a NAMED reason (the figures turn null, never 0).
 */
export async function fetchSalesFunnelCampaigns(orgId: string): Promise<SalesFunnelCampaignsAnswer> {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) {
    console.error("[billing-service] CAMPAIGN_SERVICE not configured — sales funnel campaigns cannot be read");
    return { ok: false, reason: "campaign_service_unconfigured" };
  }
  try {
    const res = await fetchWithRetry(`${url}/sales-funnel-campaigns`, {
      headers: { "x-api-key": apiKey, "x-org-id": orgId },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(
        `[billing-service] campaign-service sales-funnel-campaigns failed for org=${orgId}: ${res.status} ${await res.text()}`
      );
      return { ok: false, reason: "campaign_service_unavailable" };
    }
    const body = (await res.json()) as { salesFunnelCampaigns?: unknown };
    if (!Array.isArray(body?.salesFunnelCampaigns)) {
      console.error(`[billing-service] campaign-service sales-funnel-campaigns answered an unusable shape for org=${orgId}`);
      return { ok: false, reason: "campaign_service_unavailable" };
    }
    const campaigns = (body.salesFunnelCampaigns as Array<Record<string, unknown>>).map((c) => ({
      id: String(c.id),
      brandId: String(c.brandId),
      offerId: String(c.offerId),
      salesFunnelId: String(c.salesFunnelId),
      salesFunnelName: typeof c.salesFunnelName === "string" ? c.salesFunnelName : null,
      status: String(c.status),
      units: Array.isArray(c.units)
        ? (c.units as Array<Record<string, unknown>>).map((u) => ({
            campaignId: String(u.campaignId),
            featureSlug: String(u.featureSlug),
            legKey: String(u.legKey),
            status: String(u.status),
          }))
        : [],
    }));
    return { ok: true, campaigns };
  } catch (err) {
    console.error(`[billing-service] campaign-service sales-funnel-campaigns unreachable for org=${orgId}:`, err);
    return { ok: false, reason: "campaign_service_unavailable" };
  }
}

/** Every unit campaign id of these funnel campaigns. */
export function unitIdsOf(campaigns: SalesFunnelCampaign[]): Set<string> {
  return new Set(campaigns.flatMap((c) => c.units.map((u) => u.campaignId)));
}

/** Anything that can read (the db or an open transaction). */
type Reader = Pick<typeof db, "select">;

/** The brand's recurring funnel caps per day, read through `ex` (a transaction sees its own writes). */
export async function brandFunnelDailyCentsVia(ex: Reader, orgId: string, brandId: string): Promise<string | null> {
  const caps = await ex
    .select()
    .from(salesFunnelCaps)
    .where(and(eq(salesFunnelCaps.orgId, orgId), eq(salesFunnelCaps.brandId, brandId), isNotNull(salesFunnelCaps.maxBudgetCents)));
  return brandFunnelDailyCents(caps);
}

/**
 * The brand's DAILY figure for its by-day history (`brand_daily_budget_changes`):
 * the legacy total a writer computed + every recurring funnel cap of the brand
 * per day, so the replay agrees with `getBrandDailyBudget`. Every writer of that
 * table goes through this.
 */
export async function withRecurringFunnelCaps(
  ex: Reader,
  orgId: string,
  brandId: string,
  legacyCents: string
): Promise<string> {
  const funnel = await brandFunnelDailyCentsVia(ex, orgId, brandId);
  return funnel === null ? legacyCents : new Decimal(legacyCents).plus(funnel).toFixed(10);
}
