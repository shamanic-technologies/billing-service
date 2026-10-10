/**
 * MAX BUDGET and MAX VOLUME per SALES FUNNEL (owner 2026-10-10, migration 0078).
 *
 * Owner, verbatim: "Le user définit maintenant dans BillingService son MAX BUDGET
 * et MAX VOLUME (les deux sont importants, en one off, daily, weekly, ou
 * monthly), lus par Campaign Service pour gérer l'arrêt, AU NIVEAU DU SALES
 * FUNNEL."
 *
 * A campaign becomes a SALES FUNNEL = brand x offer x funnel, the funnel being a
 * set of (channel x leg) PIPES that features-service names and identifies
 * (lib/sales-funnel-catalogue.ts). Per funnel the customer states:
 * - a MAX BUDGET (cents, a CEILING: never discounted) over a period, and/or
 * - a MAX VOLUME (a count of items) over a period,
 * each period one of one_off, daily, weekly, monthly (UTC; a week starts
 * Monday; one_off counts from when the cap was first stated in that period).
 *
 * billing STORES the caps and SERVES what campaign-service needs to decide
 * "stop now": each cap, the window it is measured over, how much the funnel
 * CONSUMED in that window, what remains and whether it is reached. Stopping is
 * campaign-service's job. Nothing here charges anyone.
 *
 * CONSUMED, measured (never estimated):
 * - SPEND = the committed NET spend (actual + provisioned, what the org pays,
 *   exactly what campaign-service paces on) of every campaign working one of
 *   the funnel's pipes for this brand x offer, runs started in the window
 *   (runs-service `/v1/stats/costs`).
 * - VOLUME = the items the funnel's PROACTIVE pipes produced: the first contact
 *   each makes with a prospect. Measured per channel from the run that makes it
 *   (`ITEM_TASKS`); a proactive pipe on a channel we cannot measure yet makes the
 *   volume `null` with a reason, never 0. Why not "completed campaign runs":
 *   most of those produce nothing (7 days of cold email, 2026-10-10: 1,792
 *   completed campaign runs vs 720 first emails; one campaign 839 vs 39).
 *
 * A campaign belongs to a pipe when campaign-service states it for this brand,
 * this offer, the pipe's channel and the pipe's leg (`sameLeg`). A pipe shared
 * by two funnels of one offer counts its spend in both: a cap can only stop
 * EARLIER because of it, never later.
 *
 * Every figure that cannot be established is null with a named reason; a read
 * never fails because a measurement did (campaign-service still gets the caps).
 */

import { Decimal } from "decimal.js";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  salesFunnelCapChanges,
  salesFunnelCaps,
  type SalesFunnelCapRow,
} from "../db/schema.js";
import { readJson } from "./campaign-sourcing.js";
import { fetchRecurringCampaignStatuses } from "./campaign-service-client.js";
import { calendarMonthOf } from "./campaign-items.js";
import { sameLeg } from "./leg-identity.js";
import {
  getSalesFunnel,
  SalesFunnelCatalogueUnavailableError,
  SalesFunnelNotFoundError,
  type SalesFunnel,
  type SalesFunnelPipe,
} from "./sales-funnel-catalogue.js";

export const CAP_PERIODS = ["one_off", "daily", "weekly", "monthly"] as const;
export type CapPeriod = (typeof CAP_PERIODS)[number];

/** The volume unit, named on every answer. */
export const VOLUME_UNIT = "first_contacts" as const;

/**
 * The run that makes ONE first contact on a channel: a run of this service +
 * task carrying the campaign id. Cold email: the first email of a prospect's
 * sequence (`instantly-service` `email-send-step-1`, one per prospect: 52 of 52
 * on a 2026-10-09 campaign). A channel absent here has no measured volume.
 */
export const ITEM_TASKS: Readonly<Record<string, { serviceName: string; taskName: string }>> = {
  "sales-cold-email-outreach": { serviceName: "instantly-service", taskName: "email-send-step-1" },
  "feedback-request-cold-email-outreach": { serviceName: "instantly-service", taskName: "email-send-step-1" },
};

export type ConsumedUnavailableReason =
  | "sales_funnel_not_found"
  | "sales_funnel_catalogue_unavailable"
  | "campaign_service_unconfigured"
  | "campaign_service_unavailable"
  | "runs_service_unavailable"
  | "no_proactive_pipe"
  | "volume_not_measured_on_channel";

export interface FunnelCapKey {
  orgId: string;
  brandId: string;
  offerId: string;
  salesFunnelId: string;
}

export interface BudgetCapInput {
  amountCents: string;
  period: CapPeriod;
}
export interface VolumeCapInput {
  count: number;
  period: CapPeriod;
}

// ── Periods ───────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** PURE: the window a cap is measured over at `now` (UTC). one_off has no end. */
export function periodWindow(
  period: CapPeriod,
  since: Date,
  now: Date
): { start: Date; end: Date | null } {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  switch (period) {
    case "one_off":
      return { start: since, end: null };
    case "daily":
      return { start: midnight, end: new Date(midnight.getTime() + DAY_MS) };
    case "weekly": {
      const sinceMonday = (midnight.getUTCDay() + 6) % 7;
      const start = new Date(midnight.getTime() - sinceMonday * DAY_MS);
      return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
    }
    case "monthly":
      return calendarMonthOf(now);
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

const keyWhere = (k: FunnelCapKey) =>
  and(
    eq(salesFunnelCaps.orgId, k.orgId),
    eq(salesFunnelCaps.brandId, k.brandId),
    eq(salesFunnelCaps.offerId, k.offerId),
    eq(salesFunnelCaps.salesFunnelId, k.salesFunnelId)
  );

export async function getSalesFunnelCaps(k: FunnelCapKey): Promise<SalesFunnelCapRow | null> {
  const [row] = await db.select().from(salesFunnelCaps).where(keyWhere(k)).limit(1);
  return row ?? null;
}

/** Every funnel of a brand (optionally one offer) with a stated cap. */
export async function listBrandSalesFunnelCaps(
  orgId: string,
  brandId: string,
  offerId: string | null
): Promise<SalesFunnelCapRow[]> {
  const where = offerId
    ? and(eq(salesFunnelCaps.orgId, orgId), eq(salesFunnelCaps.brandId, brandId), eq(salesFunnelCaps.offerId, offerId))
    : and(eq(salesFunnelCaps.orgId, orgId), eq(salesFunnelCaps.brandId, brandId));
  return db
    .select()
    .from(salesFunnelCaps)
    .where(where)
    .orderBy(asc(salesFunnelCaps.offerId), asc(salesFunnelCaps.salesFunnelId));
}

/**
 * State (or restate) a funnel's caps. Both caps are given: an object states it,
 * null clears it; both null deletes the row. A cap restated in the SAME period
 * keeps its `since` (a one_off cap keeps counting from when it was first
 * stated); a new period, or a cap stated from nothing, starts now.
 * Journaled in the same transaction. Returns the row, or null when cleared.
 */
export async function setSalesFunnelCaps(
  k: FunnelCapKey,
  input: { maxBudget: BudgetCapInput | null; maxVolume: VolumeCapInput | null },
  changedByUserId: string | null,
  now: Date = new Date()
): Promise<SalesFunnelCapRow | null> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(salesFunnelCaps).where(keyWhere(k)).limit(1).for("update");
    // Clearing what was never stated writes nothing (idempotent DELETE).
    if (!input.maxBudget && !input.maxVolume && !existing) return null;

    await tx.insert(salesFunnelCapChanges).values({
      ...k,
      maxBudgetCents: input.maxBudget?.amountCents ?? null,
      maxBudgetPeriod: input.maxBudget?.period ?? null,
      maxVolume: input.maxVolume?.count ?? null,
      maxVolumePeriod: input.maxVolume?.period ?? null,
      changedByUserId,
      changedAt: now,
    });

    if (!input.maxBudget && !input.maxVolume) {
      if (existing) await tx.delete(salesFunnelCaps).where(keyWhere(k));
      return null;
    }

    const budgetSince = !input.maxBudget
      ? null
      : existing?.maxBudgetSince && existing.maxBudgetPeriod === input.maxBudget.period
        ? existing.maxBudgetSince
        : now;
    const volumeSince = !input.maxVolume
      ? null
      : existing?.maxVolumeSince && existing.maxVolumePeriod === input.maxVolume.period
        ? existing.maxVolumeSince
        : now;
    const values = {
      maxBudgetCents: input.maxBudget?.amountCents ?? null,
      maxBudgetPeriod: input.maxBudget?.period ?? null,
      maxBudgetSince: budgetSince,
      maxVolume: input.maxVolume?.count ?? null,
      maxVolumePeriod: input.maxVolume?.period ?? null,
      maxVolumeSince: volumeSince,
      updatedAt: now,
    };
    const [row] = await tx
      .insert(salesFunnelCaps)
      .values({ ...k, ...values, createdAt: now })
      .onConflictDoUpdate({
        target: [salesFunnelCaps.orgId, salesFunnelCaps.brandId, salesFunnelCaps.offerId, salesFunnelCaps.salesFunnelId],
        set: values,
      })
      .returning();
    return row;
  });
}

// ── Measurement ───────────────────────────────────────────────────────────────

export interface MeasuredPipe extends SalesFunnelPipe {
  /** The campaigns campaign-service states for this brand x offer on this pipe. */
  campaignIds: string[];
}

type PipesAnswer =
  | { ok: true; funnel: SalesFunnel; pipes: MeasuredPipe[] }
  | { ok: false; reason: ConsumedUnavailableReason; detail: string; funnel: SalesFunnel | null };

async function measuredPipes(k: FunnelCapKey): Promise<PipesAnswer> {
  let funnel: SalesFunnel;
  try {
    funnel = await getSalesFunnel(k.salesFunnelId);
  } catch (err) {
    if (err instanceof SalesFunnelNotFoundError) {
      return { ok: false, reason: "sales_funnel_not_found", detail: err.message, funnel: null };
    }
    console.error(`[billing-service] sales funnel caps: ${(err as Error).message}`);
    return {
      ok: false,
      reason: "sales_funnel_catalogue_unavailable",
      detail: (err as Error).message,
      funnel: null,
    };
  }
  const statuses = await fetchRecurringCampaignStatuses(k.orgId);
  if (!statuses.ok) {
    return { ok: false, reason: statuses.reason, detail: "campaign-service recurring-status unreadable", funnel };
  }
  const ofOffer = statuses.campaigns.filter((c) => c.brandId === k.brandId && c.offerId === k.offerId);
  const pipes = funnel.pipes.map((p) => ({
    ...p,
    campaignIds: ofOffer
      .filter((c) => c.featureSlug === p.channelSlug && sameLeg(p.channelSlug, c.legKey, p.legKey))
      .map((c) => c.campaignId)
      .sort(),
  }));
  return { ok: true, funnel, pipes };
}

/** Committed NET spend of these campaigns, runs started at or after `start`. */
async function spendSince(orgId: string, campaignIds: string[], start: Date): Promise<string> {
  if (campaignIds.length === 0) return new Decimal(0).toFixed(10);
  const body = await readJson<{ groups?: Array<{ netTotalCostInUsdCents?: string }> }>(
    "/v1/stats/costs",
    orgId,
    new URLSearchParams({
      campaignIds: campaignIds.join(","),
      startedAfter: start.toISOString(),
      groupBy: "campaignId",
    })
  );
  if (!Array.isArray(body.groups)) throw new Error("runs-service /v1/stats/costs returned no groups array");
  let total = new Decimal(0);
  for (const g of body.groups) {
    if (g.netTotalCostInUsdCents == null) {
      throw new Error("runs-service /v1/stats/costs stated no netTotalCostInUsdCents");
    }
    total = total.plus(g.netTotalCostInUsdCents);
  }
  return total.toFixed(10);
}

/** First contacts (completed + in flight) of these campaigns on one item task. */
async function itemsSince(
  orgId: string,
  campaignIds: string[],
  task: { serviceName: string; taskName: string },
  start: Date
): Promise<number> {
  if (campaignIds.length === 0) return 0;
  const body = await readJson<{
    groups?: Array<{ completedCount?: number; runningCount?: number }>;
  }>(
    "/v1/stats/run-outcomes",
    orgId,
    new URLSearchParams({
      campaignIds: campaignIds.join(","),
      scope: "all",
      serviceName: task.serviceName,
      taskName: task.taskName,
      startedAfter: start.toISOString(),
      groupBy: "campaignId",
    })
  );
  if (!Array.isArray(body.groups)) throw new Error("runs-service /v1/stats/run-outcomes returned no groups array");
  let n = 0;
  for (const g of body.groups) {
    if (typeof g.completedCount !== "number" || typeof g.runningCount !== "number") {
      throw new Error("runs-service /v1/stats/run-outcomes stated no completedCount/runningCount");
    }
    n += g.completedCount + g.runningCount;
  }
  return n;
}

// ── The served view ───────────────────────────────────────────────────────────

interface Measured<T> {
  consumed: T | null;
  reason: ConsumedUnavailableReason | null;
  detail: string | null;
}

export interface BudgetCapView {
  amountCents: string;
  period: CapPeriod;
  periodStart: string;
  /** Exclusive; null on a one_off cap (it never resets). */
  periodEnd: string | null;
  consumedCents: string | null;
  remainingCents: string | null;
  reached: boolean | null;
  consumedUnavailableReason: ConsumedUnavailableReason | null;
  consumedUnavailableDetail: string | null;
}

export interface VolumeCapView {
  count: number;
  period: CapPeriod;
  unit: typeof VOLUME_UNIT;
  periodStart: string;
  periodEnd: string | null;
  consumed: number | null;
  remaining: number | null;
  reached: boolean | null;
  consumedUnavailableReason: ConsumedUnavailableReason | null;
  consumedUnavailableDetail: string | null;
}

export interface SalesFunnelCapsView extends FunnelCapKey {
  /** false = nothing stated for this funnel (both caps null). */
  stated: boolean;
  updatedAt: string | null;
  maxBudget: BudgetCapView | null;
  maxVolume: VolumeCapView | null;
  /** features-service's name of the funnel; null when not read (nothing stated) or unreadable. */
  salesFunnelName: string | null;
  /** The pipes measured and the campaigns found on each; null when not read or unreadable. */
  pipes: MeasuredPipe[] | null;
}

const fixed = (v: Decimal) => v.toFixed(10);

function budgetView(row: SalesFunnelCapRow, now: Date, m: Measured<string>): BudgetCapView | null {
  if (row.maxBudgetCents == null || row.maxBudgetPeriod == null || row.maxBudgetSince == null) return null;
  const period = row.maxBudgetPeriod as CapPeriod;
  const w = periodWindow(period, row.maxBudgetSince, now);
  const cap = new Decimal(row.maxBudgetCents);
  const consumed = m.consumed === null ? null : new Decimal(m.consumed);
  return {
    amountCents: row.maxBudgetCents,
    period,
    periodStart: w.start.toISOString(),
    periodEnd: w.end ? w.end.toISOString() : null,
    consumedCents: consumed ? fixed(consumed) : null,
    remainingCents: consumed ? fixed(Decimal.max(cap.minus(consumed), 0)) : null,
    reached: consumed ? consumed.greaterThanOrEqualTo(cap) : null,
    consumedUnavailableReason: m.reason,
    consumedUnavailableDetail: m.detail,
  };
}

function volumeView(row: SalesFunnelCapRow, now: Date, m: Measured<number>): VolumeCapView | null {
  if (row.maxVolume == null || row.maxVolumePeriod == null || row.maxVolumeSince == null) return null;
  const period = row.maxVolumePeriod as CapPeriod;
  const w = periodWindow(period, row.maxVolumeSince, now);
  return {
    count: row.maxVolume,
    period,
    unit: VOLUME_UNIT,
    periodStart: w.start.toISOString(),
    periodEnd: w.end ? w.end.toISOString() : null,
    consumed: m.consumed,
    remaining: m.consumed === null ? null : Math.max(row.maxVolume - m.consumed, 0),
    reached: m.consumed === null ? null : m.consumed >= row.maxVolume,
    consumedUnavailableReason: m.reason,
    consumedUnavailableDetail: m.detail,
  };
}

const NOT_MEASURED = <T>(): Measured<T> => ({ consumed: null, reason: null, detail: null });

async function measureBudget(k: FunnelCapKey, row: SalesFunnelCapRow, pipes: MeasuredPipe[], now: Date): Promise<Measured<string>> {
  const w = periodWindow(row.maxBudgetPeriod as CapPeriod, row.maxBudgetSince!, now);
  const ids = [...new Set(pipes.flatMap((p) => p.campaignIds))];
  try {
    return { consumed: await spendSince(k.orgId, ids, w.start), reason: null, detail: null };
  } catch (err) {
    console.error(`[billing-service] sales funnel caps: spend of ${k.salesFunnelId} unreadable: ${(err as Error).message}`);
    return { consumed: null, reason: "runs_service_unavailable", detail: (err as Error).message };
  }
}

async function measureVolume(k: FunnelCapKey, row: SalesFunnelCapRow, pipes: MeasuredPipe[], now: Date): Promise<Measured<number>> {
  const proactive = pipes.filter((p) => p.mode === "proactive");
  if (proactive.length === 0) {
    return { consumed: null, reason: "no_proactive_pipe", detail: `sales funnel ${k.salesFunnelId} has no proactive pipe` };
  }
  const unmeasured = proactive.filter((p) => !ITEM_TASKS[p.channelSlug]).map((p) => p.channelSlug);
  if (unmeasured.length > 0) {
    return {
      consumed: null,
      reason: "volume_not_measured_on_channel",
      detail: `no first-contact measure on ${[...new Set(unmeasured)].join(", ")}`,
    };
  }
  const w = periodWindow(row.maxVolumePeriod as CapPeriod, row.maxVolumeSince!, now);
  // One read per item task: the campaigns of every proactive pipe making it.
  const byTask = new Map<string, { task: { serviceName: string; taskName: string }; ids: Set<string> }>();
  for (const p of proactive) {
    const task = ITEM_TASKS[p.channelSlug];
    const key = `${task.serviceName}\u0000${task.taskName}`;
    const entry = byTask.get(key) ?? { task, ids: new Set<string>() };
    p.campaignIds.forEach((id) => entry.ids.add(id));
    byTask.set(key, entry);
  }
  try {
    let n = 0;
    for (const { task, ids } of byTask.values()) n += await itemsSince(k.orgId, [...ids], task, w.start);
    return { consumed: n, reason: null, detail: null };
  } catch (err) {
    console.error(`[billing-service] sales funnel caps: volume of ${k.salesFunnelId} unreadable: ${(err as Error).message}`);
    return { consumed: null, reason: "runs_service_unavailable", detail: (err as Error).message };
  }
}

/** The caps of one funnel, each with its window and what the funnel consumed in it. */
export async function composeSalesFunnelCapsView(
  k: FunnelCapKey,
  now: Date = new Date()
): Promise<SalesFunnelCapsView> {
  const row = await getSalesFunnelCaps(k);
  if (!row) {
    return { ...k, stated: false, updatedAt: null, maxBudget: null, maxVolume: null, salesFunnelName: null, pipes: null };
  }
  const answer = await measuredPipes(k);
  let budget: Measured<string> = NOT_MEASURED();
  let volume: Measured<number> = NOT_MEASURED();
  if (!answer.ok) {
    budget = { consumed: null, reason: answer.reason, detail: answer.detail };
    volume = { consumed: null, reason: answer.reason, detail: answer.detail };
  } else {
    [budget, volume] = await Promise.all([
      row.maxBudgetCents != null ? measureBudget(k, row, answer.pipes, now) : Promise.resolve(NOT_MEASURED<string>()),
      row.maxVolume != null ? measureVolume(k, row, answer.pipes, now) : Promise.resolve(NOT_MEASURED<number>()),
    ]);
  }
  return {
    ...k,
    stated: true,
    updatedAt: row.updatedAt.toISOString(),
    maxBudget: budgetView(row, now, budget),
    maxVolume: volumeView(row, now, volume),
    salesFunnelName: answer.funnel?.name ?? null,
    pipes: answer.ok ? answer.pipes : null,
  };
}

/** The stated caps of a row, without measurement (the brand list). */
export function statedCapsOf(row: SalesFunnelCapRow) {
  return {
    offerId: row.offerId,
    salesFunnelId: row.salesFunnelId,
    maxBudget:
      row.maxBudgetCents != null
        ? { amountCents: row.maxBudgetCents, period: row.maxBudgetPeriod as CapPeriod }
        : null,
    maxVolume:
      row.maxVolume != null ? { count: row.maxVolume, period: row.maxVolumePeriod as CapPeriod, unit: VOLUME_UNIT } : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export { SalesFunnelCatalogueUnavailableError, SalesFunnelNotFoundError };
