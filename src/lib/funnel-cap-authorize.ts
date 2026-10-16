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
 *   figure (committed NET, actual + provisioned), MINUS the caller's OWN hold for
 *   this very spend: the fleet provisions BEFORE it authorizes (chat-service
 *   /complete: provision 65.88c on its run, then authorize), so the hold is already
 *   in `consumed` and is also `requiredCents`. Counting it twice refused every LLM
 *   spend of a funnel with room, forever (FUNNEL-CAP-OWN-HOLD-1016: 226 + 66 <= 350
 *   refused as 292 + 66). The own hold = the `provisioned` cost rows of the
 *   request's `x-run-id` (run on this campaign and org) matching the authorized
 *   items one to one (cost name + quantity), created before the measurement
 *   started (so they are in it), never excluded before. Read only when the spend
 *   would otherwise be refused; unreadable = not excluded (stops early, never late).
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
import { readJson } from "./runs-org-read.js";
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
/** Cost ids already excluded as a granted spend's own hold: never excluded twice. */
const excludedHolds = new Map<string, number>();
/** A caller's own hold is provisioned right before it authorizes; older rows are someone else's spend. */
export const OWN_HOLD_MAX_AGE_MS = 5 * 60_000;

/** Test hook: forget every cached measurement, reservation and log latch. */
export function __resetFunnelCapAuthorize(): void {
  measures.clear();
  funnelCampaigns.clear();
  reservations.clear();
  lastErrorLog.clear();
  excludedHolds.clear();
}

export interface AuthorizeItem {
  costName: string;
  quantity: number;
}

interface OwnHold {
  costIds: string[];
  cents: Decimal;
  /** Latest creation instant of the matched rows (ms). */
  createdAt: number;
}

interface RunRead {
  organizationId?: string | null;
  campaignId?: string | null;
  costs?: Array<{
    id: string;
    costName: string;
    quantity: string | number;
    status: string;
    netCostInUsdCents?: string | null;
    totalCostInUsdCents: string;
    createdAt: string;
  }>;
}

/**
 * PURE: the caller's OWN provisioned hold for this spend, from its run's cost rows:
 * each authorized item matched to at most one `provisioned` row of the same cost name
 * and quantity, recent, not excluded before. null when the run is not this campaign's
 * (its costs are not in the measurement) or nothing matches.
 */
export function ownHoldOf(
  run: RunRead,
  input: { orgId: string; campaignId: string; items: AuthorizeItem[] },
  nowMs: number,
  alreadyExcluded: (costId: string) => boolean = () => false
): OwnHold | null {
  if (!run.campaignId || !sameId(run.campaignId, input.campaignId)) return null;
  if (!run.organizationId || !sameId(run.organizationId, input.orgId)) return null;
  const free = (run.costs ?? []).filter(
    (c) =>
      c.status === "provisioned" &&
      !alreadyExcluded(c.id) &&
      new Date(c.createdAt).getTime() > nowMs - OWN_HOLD_MAX_AGE_MS
  );
  const picked: typeof free = [];
  for (const item of input.items) {
    const row = free.find(
      (c) => !picked.includes(c) && c.costName === item.costName && new Decimal(c.quantity).equals(item.quantity)
    );
    if (row) picked.push(row);
  }
  if (picked.length === 0) return null;
  return {
    costIds: picked.map((c) => c.id),
    cents: picked.reduce((s, c) => s.plus(c.netCostInUsdCents ?? c.totalCostInUsdCents), new Decimal(0)),
    createdAt: Math.max(...picked.map((c) => new Date(c.createdAt).getTime())),
  };
}

async function readOwnHold(
  input: { orgId: string; campaignId: string; runId: string; items: AuthorizeItem[] },
  nowMs: number
): Promise<OwnHold | null> {
  for (const [id, at] of excludedHolds) if (at < nowMs - OWN_HOLD_MAX_AGE_MS * 2) excludedHolds.delete(id);
  try {
    const run = await readJson<RunRead>(`/v1/runs/${encodeURIComponent(input.runId)}`, input.orgId, new URLSearchParams());
    return ownHoldOf(run, input, nowMs, (id) => excludedHolds.has(id));
  } catch (err) {
    loudOnce(
      `hold|${input.orgId}`,
      `[billing-service] sales funnel max budget: run ${input.runId} unreadable (${(err as Error).message}); ` +
        `the caller's own provisioned hold is not excluded from the consumption`
    );
    return null;
  }
}

/** The consumption this spend is measured against: the measurement minus its own hold, when the hold is in it. */
function consumedForSpend(m: TimedMeasure, hold: OwnHold | null): string | null {
  if (m.consumedCents === null) return null;
  if (!hold || hold.createdAt >= m.startedAt) return m.consumedCents;
  return Decimal.max(new Decimal(m.consumedCents).minus(hold.cents), 0).toFixed(10);
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
  /** The request's x-run-id: the run whose provisioned rows may be this spend's own hold. */
  runId?: string;
  /** The authorized items (cost name + quantity), matched to the own hold one to one. */
  items?: AuthorizeItem[];
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

  // The caller's own hold: read only when, without excluding it, this spend would be
  // refused (the common path costs no extra read). Awaited BEFORE the decision.
  let hold: OwnHold | null = null;
  if (input.runId && input.items?.length) {
    const wouldOverflow = held.caps.some((row, i) => {
      const m = measured[i];
      if (m.consumedCents === null) return false;
      const reserved = reservedSince(capId(row), m.startedAt - RESERVATION_LAG_MS, Date.now());
      return new Decimal(m.consumedCents).plus(reserved).plus(requiredCents).greaterThan(row.maxBudgetCents!);
    });
    if (wouldOverflow) {
      hold = await readOwnHold({ orgId, campaignId, runId: input.runId, items: input.items }, Date.now());
    }
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
    const consumed = consumedForSpend(m, hold);
    const cap = {
      salesFunnelId: row.salesFunnelId,
      salesFunnelCampaignId: row.salesFunnelCampaignId ?? null,
      amountCents: new Decimal(row.maxBudgetCents!).toFixed(10),
      period: row.maxBudgetPeriod!,
      consumedCents: consumed,
      reservedCents: reserved.toFixed(10),
    };
    if (heldRefusalOf(row, m.windowStart, consumed)) {
      return { allowed: false, reason: SALES_FUNNEL_MAX_BUDGET_REACHED, cap };
    }
    if (consumed === null) {
      loudOnce(
        `consumed|${id}`,
        `[billing-service] sales funnel max budget ${row.salesFunnelId} (org ${orgId}, funnel campaign ` +
          `${row.salesFunnelCampaignId ?? "-"}): consumption unreadable (${m.reason}: ${m.detail}); spends of its campaigns refused`
      );
      return { allowed: false, reason: SALES_FUNNEL_MAX_BUDGET_UNREADABLE, cap };
    }
    if (new Decimal(consumed).plus(reserved).plus(required).greaterThan(row.maxBudgetCents!)) {
      // Recorded (held for the window) only when the cap's REAL consumption plus this
      // spend passes it. A refusal only in-flight reservations caused is for this
      // spend alone: they clear within seconds, and holding the cap on it served
      // "4.6 of 200 cents, reached" forever on a one-off (2026-10-15).
      // Fire-and-forget would lose the record on a crash: awaited AFTER the decision.
      if (refusalOverflows(consumed, required, row.maxBudgetCents!)) {
        await recordMaxBudgetRefusal(row, m.windowStart, requiredCents, now);
      }
      return { allowed: false, reason: SALES_FUNNEL_MAX_BUDGET_REACHED, cap };
    }
  }
  for (const row of held.caps) {
    const id = capId(row);
    reservations.set(id, [...(reservations.get(id) ?? []), { at: nowMs, cents: required }]);
  }
  for (const costId of hold?.costIds ?? []) excludedHolds.set(costId, nowMs);
  return { allowed: true };
}
