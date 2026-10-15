/**
 * A SALES FUNNEL MAX BUDGET binds every spend, BEFORE it happens (owner 2026-10-12,
 * LEADS-ONLY-FUNNEL-CAMPAIGN: "the campaign spends AT MOST $5"; 2026-10-10: "always
 * respect the user budget").
 *
 * campaign-service checks the caps read (`maxBudget.reached`) before each RUN, but a
 * run is several metered spends (a lead serve: enrichment, verification, LLM
 * judgments). At 490c of 500c `reached` is false, the run starts, and the cap ends
 * one run's cost over. Every metered spend of the fleet goes through
 * `POST /v1/customer_balance/authorize` with the unit's `x-campaign-id`, so the cap
 * is enforced there, per spend:
 *
 * - WHICH cap binds a campaign: a UNIT of a funnel campaign (campaign-service
 *   `/sales-funnel-campaigns`) is held to the cap `capOfFunnelCampaign` names (its
 *   own, else the funnel-wide one), the same answer campaign-service reads. A
 *   campaign that is no unit but whose spend a max budget COUNTS as a lead source
 *   feeding the funnel is held to every such cap. Anything else: nothing here,
 *   byte-identical to before.
 * - REFUSED when consumed + reserved + this spend > the cap's amount, with
 *   `reason: sales_funnel_max_budget_reached`. `consumed` is the caps read's own
 *   figure (committed NET, actual + provisioned). A caller that PROVISIONS before
 *   authorizing is therefore counted twice for this one spend: the cap stops at most
 *   one spend early, never late.
 * - CONCURRENT spends cannot both slip under: the decision and the reservation are
 *   one synchronous step (no await between them; billing runs one process), and every
 *   spend authorized since the measurement started (minus RESERVATION_LAG_MS for
 *   provisions to land in runs-service) is added to the consumption.
 * - A refusal is RECORDED on the cap row (`recordMaxBudgetRefusal`) only when the
 *   cap's real consumption plus the refused spend passes the amount: the caps read
 *   then serves `reached: true` for the rest of the window at that amount, so
 *   campaign-service stops dispatching runs this would refuse anyway. A refusal
 *   only in-flight reservations caused holds that spend alone, never the window.
 * - Our OWN platform org is held too: a cap is the customer's statement, not a
 *   balance question (the platform-org early return comes AFTER this check).
 * - Consumption unreadable on a cap that binds = refused
 *   (`sales_funnel_max_budget_unreadable`), never a guess. Membership unreadable
 *   (campaign-service down) = cannot say any cap binds: allowed, said loudly.
 */
import { Decimal } from "decimal.js";
import type { SalesFunnelCapRow } from "../db/schema.js";
import { capOfFunnelCampaign, orgFunnelCaps, fetchSalesFunnelCampaigns, type SalesFunnelCampaignsAnswer } from "./funnel-campaigns.js";
import { heldRefusalOf, measureMaxBudget, periodWindow, recordMaxBudgetRefusal, refusalOverflows, type BudgetMeasure, type CapPeriod } from "./sales-funnel-caps.js";

export const SALES_FUNNEL_MAX_BUDGET_REACHED = "sales_funnel_max_budget_reached" as const;
export const SALES_FUNNEL_MAX_BUDGET_UNREADABLE = "sales_funnel_max_budget_unreadable" as const;
export type FunnelCapRefusalReason = typeof SALES_FUNNEL_MAX_BUDGET_REACHED | typeof SALES_FUNNEL_MAX_BUDGET_UNREADABLE;

/** How long one measurement of a cap (and of an org's funnel campaigns) is reused. */
export const MEASURE_TTL_MS = 10_000;
/** How long before a measurement started a granted spend may still be missing from it. */
export const RESERVATION_LAG_MS = 30_000;
const ERROR_LOG_EVERY_MS = 60_000;

export interface FunnelCapRefusal {
  reason: FunnelCapRefusalReason;
  cap: {
    salesFunnelId: string;
    salesFunnelCampaignId: string | null;
    amountCents: string;
    period: string;
    consumedCents: string | null;
    reservedCents: string;
  };
}

export type FunnelCapVerdict = { allowed: true } | ({ allowed: false } & FunnelCapRefusal);

type TimedMeasure = BudgetMeasure & { startedAt: number };

const measures = new Map<string, { at: number; p: Promise<TimedMeasure> }>();
const funnelCampaigns = new Map<string, { at: number; p: Promise<SalesFunnelCampaignsAnswer> }>();
const reservations = new Map<string, Array<{ at: number; cents: Decimal }>>();
const lastErrorLog = new Map<string, number>();

/** Test hook: forget every cached measurement, reservation and log latch. */
export function __resetFunnelCapAuthorize(): void {
  measures.clear();
  funnelCampaigns.clear();
  reservations.clear();
  lastErrorLog.clear();
}

const capId = (r: SalesFunnelCapRow) =>
  [r.orgId, r.brandId, r.offerId, r.salesFunnelId, r.salesFunnelCampaignId ?? ""].join("|").toLowerCase();

const hasBudget = (r: SalesFunnelCapRow) => r.maxBudgetCents != null && r.maxBudgetPeriod != null && r.maxBudgetSince != null;

function loudOnce(key: string, message: string): void {
  const now = Date.now();
  if ((lastErrorLog.get(key) ?? 0) > now - ERROR_LOG_EVERY_MS) return;
  lastErrorLog.set(key, now);
  console.error(message);
}

function cachedFunnelCampaigns(orgId: string): Promise<SalesFunnelCampaignsAnswer> {
  const hit = funnelCampaigns.get(orgId);
  if (hit && hit.at > Date.now() - MEASURE_TTL_MS) return hit.p;
  const p = fetchSalesFunnelCampaigns(orgId);
  funnelCampaigns.set(orgId, { at: Date.now(), p });
  return p;
}

function cachedMeasure(row: SalesFunnelCapRow, now: Date): Promise<TimedMeasure> {
  const windowStart = periodWindow(row.maxBudgetPeriod as CapPeriod, row.maxBudgetSince!, now).start;
  const key = `${capId(row)}|${windowStart.toISOString()}`;
  const hit = measures.get(key);
  if (hit && hit.at > Date.now() - MEASURE_TTL_MS) return hit.p;
  const startedAt = Date.now();
  const p = measureMaxBudget(row, now)
    .then((m) => ({ ...m, startedAt }))
    .catch((err: unknown): TimedMeasure => ({
      windowStart,
      pipeCampaignIds: null,
      sourceCampaignIds: null,
      consumedCents: null,
      reason: "runs_service_unavailable",
      detail: (err as Error).message,
      startedAt,
    }));
  measures.set(key, { at: startedAt, p });
  return p;
}

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * PURE: the caps a campaign's spend is held to. A unit of a funnel campaign: the
 * one cap `capOfFunnelCampaign` names, if it states a max budget. Otherwise: every
 * max budget that counts the campaign as a feeding lead source.
 */
export function capsHoldingCampaign(
  campaignId: string,
  caps: SalesFunnelCapRow[],
  fcs: Array<{ id: string; brandId: string; offerId: string; salesFunnelId: string; units: Array<{ campaignId: string }> }>,
  sourceMeasures: Array<{ row: SalesFunnelCapRow; sourceCampaignIds: string[] | null }>
): { unit: boolean; caps: SalesFunnelCapRow[] } {
  const fc = fcs.find((c) => c.units.some((u) => sameId(u.campaignId, campaignId)));
  if (fc) {
    const held = capOfFunnelCampaign(caps, fc);
    return { unit: true, caps: held && hasBudget(held) ? [held] : [] };
  }
  return {
    unit: false,
    caps: sourceMeasures.filter((m) => m.sourceCampaignIds?.some((id) => sameId(id, campaignId))).map((m) => m.row),
  };
}

function reservedSince(id: string, since: number, now: number): Decimal {
  const kept = (reservations.get(id) ?? []).filter((r) => r.at > now - MEASURE_TTL_MS - RESERVATION_LAG_MS - 5_000);
  reservations.set(id, kept);
  return kept.filter((r) => r.at >= since).reduce((s, r) => s.plus(r.cents), new Decimal(0));
}

/**
 * May this spend happen under the sales funnel max budgets that hold the campaign?
 * `requiredCents` is the spend's NET cost (authorize's netted estimate). Allowed
 * spends are reserved before this returns.
 */
export async function checkFunnelCapsForSpend(input: {
  orgId: string;
  campaignId: string | undefined;
  requiredCents: string;
  now?: Date;
}): Promise<FunnelCapVerdict> {
  const { orgId, campaignId, requiredCents } = input;
  if (!campaignId) return { allowed: true };
  const now = input.now ?? new Date();
  const caps = await orgFunnelCaps(orgId);
  const budgetCaps = caps.filter(hasBudget);
  if (budgetCaps.length === 0) return { allowed: true };

  const fcs = await cachedFunnelCampaigns(orgId);
  if (!fcs.ok) {
    loudOnce(
      `fcs|${orgId}`,
      `[billing-service] sales funnel max budget: cannot tell whether campaign ${campaignId} (org ${orgId}) is held to one ` +
        `(campaign-service ${fcs.reason}): spend allowed unchecked`
    );
    return { allowed: true };
  }
  let held = capsHoldingCampaign(campaignId, caps, fcs.campaigns, []);
  let measured: TimedMeasure[];
  if (held.unit) {
    if (held.caps.length === 0) return { allowed: true };
    measured = [await cachedMeasure(held.caps[0], now)];
  } else {
    // Not a unit: only a lead source a max budget counts can be held. Every budget
    // cap of the org is measured (cached) to know which sources each one counts.
    measured = await Promise.all(budgetCaps.map((r) => cachedMeasure(r, now)));
    held = capsHoldingCampaign(
      campaignId,
      caps,
      fcs.campaigns,
      budgetCaps.map((row, i) => ({ row, sourceCampaignIds: measured[i].sourceCampaignIds }))
    );
    for (let i = 0; i < budgetCaps.length; i++) {
      if (measured[i].sourceCampaignIds === null) {
        loudOnce(
          `src|${capId(budgetCaps[i])}`,
          `[billing-service] sales funnel max budget ${budgetCaps[i].salesFunnelId} (org ${orgId}): its lead sources are ` +
            `unreadable (${measured[i].reason}: ${measured[i].detail}); a source campaign's spend is not checked against it`
        );
      }
    }
    if (held.caps.length === 0) return { allowed: true };
    measured = held.caps.map((r) => measured[budgetCaps.indexOf(r)]);
  }

  // ── From here to the reservation: NO await. One synchronous decision per spend,
  // so two concurrent spends of one funnel campaign cannot both pass on one reading.
  const nowMs = Date.now();
  const required = new Decimal(requiredCents);
  for (let i = 0; i < held.caps.length; i++) {
    const row = held.caps[i];
    const m = measured[i];
    const id = capId(row);
    const reserved = reservedSince(id, m.startedAt - RESERVATION_LAG_MS, nowMs);
    const cap = {
      salesFunnelId: row.salesFunnelId,
      salesFunnelCampaignId: row.salesFunnelCampaignId ?? null,
      amountCents: new Decimal(row.maxBudgetCents!).toFixed(10),
      period: row.maxBudgetPeriod!,
      consumedCents: m.consumedCents,
      reservedCents: reserved.toFixed(10),
    };
    if (heldRefusalOf(row, m.windowStart, m.consumedCents)) {
      return { allowed: false, reason: SALES_FUNNEL_MAX_BUDGET_REACHED, cap };
    }
    if (m.consumedCents === null) {
      loudOnce(
        `consumed|${id}`,
        `[billing-service] sales funnel max budget ${row.salesFunnelId} (org ${orgId}, funnel campaign ` +
          `${row.salesFunnelCampaignId ?? "-"}): consumption unreadable (${m.reason}: ${m.detail}); spends of its campaigns refused`
      );
      return { allowed: false, reason: SALES_FUNNEL_MAX_BUDGET_UNREADABLE, cap };
    }
    if (new Decimal(m.consumedCents).plus(reserved).plus(required).greaterThan(row.maxBudgetCents!)) {
      // Recorded (held for the window) only when the cap's REAL consumption plus this
      // spend passes it. A refusal only in-flight reservations caused is for this
      // spend alone: they clear within seconds, and holding the cap on it served
      // "4.6 of 200 cents, reached" forever on a one-off (2026-10-15).
      // Fire-and-forget would lose the record on a crash: awaited AFTER the decision.
      if (refusalOverflows(m.consumedCents, required, row.maxBudgetCents!)) {
        await recordMaxBudgetRefusal(row, m.windowStart, requiredCents, now);
      }
      return { allowed: false, reason: SALES_FUNNEL_MAX_BUDGET_REACHED, cap };
    }
  }
  for (const row of held.caps) {
    const id = capId(row);
    reservations.set(id, [...(reservations.get(id) ?? []), { at: nowMs, cents: required }]);
  }
  return { allowed: true };
}
