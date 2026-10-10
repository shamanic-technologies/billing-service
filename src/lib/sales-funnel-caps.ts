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
 *   the funnel's pipes for this brand x offer, PLUS every SOURCE campaign
 *   (Start -> Lead found) of this brand x offer on an origin feeding one of
 *   those pipes (features-service `originsByChannel`): a budget is ALL-INCLUSIVE,
 *   sourcing + sending + LLM (owner 2026-10-09). Runs started in the window
 *   (runs-service `/v1/stats/costs`). An outreach campaign whose sourcing still
 *   runs under its own id is covered by its own campaign id.
 * - VOLUME, in the unit billing names on the answer (`unit`):
 *   - `first_contacts` when the funnel has a PROACTIVE pipe: the first contact
 *     each proactive pipe makes with a prospect;
 *   - `prospects_handled` when every pipe is REACTIVE (a reactive funnel
 *     contacts nobody first): each prospect a reactive pipe takes on once they
 *     reached its start step (a reply, a visit...). Measured per channel from
 *     the run that handles one (`REACTIVE_ITEM_TASKS`); no reactive channel is
 *     pinned yet, so it reads null + `volume_not_measured_on_channel`, never 0.
 *   The unit follows what billing MEASURES (the pipe modes it reads to measure),
 *   not the relayed type; the two use the same rule upstream.
 * - The proactive measure: Measured per channel from the run that makes it
 *   (`ITEM_TASKS`); a proactive pipe on a channel we cannot measure yet makes the
 *   volume `null` with a reason, never 0. Why not "completed campaign runs":
 *   most of those produce nothing (7 days of cold email, 2026-10-10: 1,792
 *   completed campaign runs vs 720 first emails; one campaign 839 vs 39).
 *
 * A campaign belongs to a pipe when campaign-service states it for this brand,
 * this offer, the pipe's channel and the pipe's leg (`sameLeg`). A pipe shared
 * by two funnels of one offer counts its spend in both, and so does a source
 * feeding two funnels: a cap can only stop EARLIER because of it, never later.
 *
 * TYPE: `salesFunnelType` is features-service's served `type`, RELAYED (never
 * derived here); null + `salesFunnelTypeUnavailableReason` when not served or
 * the funnel is unreadable. It labels the caps ("Max budget" vs "Up to $X").
 *
 * Every figure that cannot be established is null with a named reason; a read
 * never fails because a measurement did (campaign-service still gets the caps).
 */

import { Decimal } from "decimal.js";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
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
import { getSalesPathTerms, type SalesPathTerms } from "./sales-path-terms.js";
import { brandFunnelDailyCentsVia } from "./funnel-campaigns.js";
import { getBrandDailyBudget, getLegacyBrandDailyBudget } from "./brand-budgets.js";
import {
  billingAccounts,
  brandDailyBudgetChanges,
  brandSalesBudgets,
  campaignDailyBudgets,
  type CeilingRow,
} from "../db/schema.js";
import { campaignCeilingRows, type CampaignKey } from "./campaign-budgets.js";
import { recurringDailyCentsOf } from "./funnel-campaigns.js";
import { cmpCents } from "./cents.js";
import {
  getSalesFunnel,
  type SalesFunnelType,
  SalesFunnelCatalogueUnavailableError,
  SalesFunnelNotFoundError,
  type SalesFunnel,
  type SalesFunnelPipe,
} from "./sales-funnel-catalogue.js";

export const CAP_PERIODS = ["one_off", "daily", "weekly", "monthly"] as const;
export type CapPeriod = (typeof CAP_PERIODS)[number];

/** The volume units billing names on every answer (see the header). */
export const VOLUME_UNITS = ["first_contacts", "prospects_handled"] as const;
export type VolumeUnit = (typeof VOLUME_UNITS)[number];

/** PURE: the unit a funnel's volume is counted in: first contacts when a pipe is proactive. */
export function volumeUnitOf(funnel: Pick<SalesFunnel, "pipes">): VolumeUnit {
  return funnel.pipes.some((p) => p.mode === "proactive") ? "first_contacts" : "prospects_handled";
}

export type SalesFunnelTypeUnavailableReason =
  | "type_not_served_by_features_service"
  | "sales_funnel_not_found"
  | "sales_funnel_catalogue_unavailable";

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

/**
 * The run that HANDLES ONE prospect on a REACTIVE channel (a reactive funnel's
 * `prospects_handled`). Empty on purpose: prod 2026-10-10, an AI meeting booking
 * campaign's runs carry no task that maps one-to-one to a prospect handled
 * (polling workflow runs, LLM calls, judgments), so nothing is pinned rather
 * than a guess. Add a channel here once one run = one prospect is verified.
 */
export const REACTIVE_ITEM_TASKS: Readonly<Record<string, { serviceName: string; taskName: string; distinctParent: true }>> = {
  // AI meeting booking answers a prospect who replied: one run of its workflow
  // that did work = one prospect taken on. Its workflow polls ~400 times a day
  // doing nothing (no paid child); the runs that take a prospect on call the LLM
  // (`chat-service` `complete`). Counted as DISTINCT parent workflow runs of
  // those calls (prod 14d 2026-10-10: 15 workflow runs with a completion, 14 of
  // them the only runs with any cost, out of 6,035).
  "ai-meeting-booking": { serviceName: "chat-service", taskName: "complete", distinctParent: true },
};

export type ConsumedUnavailableReason =
  | "sales_funnel_not_found"
  | "sales_funnel_catalogue_unavailable"
  | "campaign_service_unconfigured"
  | "campaign_service_unavailable"
  | "runs_service_unavailable"
  | "no_proactive_pipe"
  | "volume_not_measured_on_channel"
  | "sourcing_catalogue_unavailable";

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

/** A pre-funnel campaign whose per-campaign ceiling a funnel cap replaces (campaign-service conversion). */
export interface ReplacedCeilingKey {
  featureSlug: string;
  legKey: string | null;
}

/** What a conversion moved, served to campaign-service so it can log it. */
export interface CeilingConversion {
  replacedCeilings: Array<{ featureSlug: string; offerId: string | null; legKey: string | null; dailyBudgetCents: string }>;
  /** Sum of the replaced ceilings per day. */
  replacedDailyCents: string;
  /** The new max budget per day (weekly / 7, monthly / 30). */
  capDailyCents: string;
  brandDailyBudgetBefore: string | null;
  brandDailyBudgetAfter: string | null;
}

/** A conversion billing refuses (nothing written): 409 with the reason. */
export class FunnelConversionRefusedError extends Error {
  constructor(public readonly reason: string, message: string, public readonly detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "FunnelConversionRefusedError";
  }
}

/** Rounding a weekly / monthly cap per day may leave: at most one cent. */
const CONVERSION_TOLERANCE_CENTS = new Decimal(1);

export async function setSalesFunnelCaps(
  k: FunnelCapKey,
  input: {
    maxBudget: BudgetCapInput | null;
    maxVolume: VolumeCapInput | null;
    /** features-service's type of the funnel, read by the caller at write; null = not served. */
    salesFunnelType?: "proactive" | "reactive" | null;
  },
  changedByUserId: string | null,
  now: Date = new Date(),
  replacesCeilings: ReplacedCeilingKey[] | null = null
): Promise<{ row: SalesFunnelCapRow | null; conversion: CeilingConversion | null }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(salesFunnelCaps).where(keyWhere(k)).limit(1).for("update");
    // Clearing what was never stated writes nothing (idempotent DELETE).
    if (!input.maxBudget && !input.maxVolume && !existing && !replacesCeilings) return { row: null, conversion: null };
    const conversion = replacesCeilings ? await convertCeilings(tx, k, input.maxBudget, replacesCeilings) : null;
    const funnelDailyBefore = await brandFunnelDailyCentsVia(tx, k.orgId, k.brandId);
    // The brand's by-day history (`brand_daily_budget_changes`) follows its daily
    // figure: legacy total + every recurring funnel cap per day. Appended only
    // when the recurring funnel part moved (a one_off or volume-only change does
    // not move the daily figure).
    const journalBrandDaily = async () => {
      const after = await brandFunnelDailyCentsVia(tx, k.orgId, k.brandId);
      if (cmpCents(funnelDailyBefore ?? "0", after ?? "0") === 0 && (funnelDailyBefore === null) === (after === null)) return;
      const legacy = await getLegacyBrandDailyBudget(k.orgId, k.brandId, tx);
      const total = new Decimal(legacy?.dailyBudgetCents ?? "0").plus(after ?? "0").toFixed(10);
      await tx.insert(brandDailyBudgetChanges).values({ orgId: k.orgId, brandId: k.brandId, dailyBudgetCents: total, changedAt: now });
    };

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
      await journalBrandDaily();
      return { row: null, conversion };
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
      salesFunnelType: input.salesFunnelType ?? existing?.salesFunnelType ?? null,
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
    await journalBrandDaily();
    if (conversion) {
      const after = await getLegacyBrandDailyBudget(k.orgId, k.brandId, tx);
      const funnel = await brandFunnelDailyCentsVia(tx, k.orgId, k.brandId);
      conversion.brandDailyBudgetAfter =
        after === null && funnel === null ? null : new Decimal(after?.dailyBudgetCents ?? "0").plus(funnel ?? "0").toFixed(10);
    }
    return { row, conversion };
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A pre-offer ceiling (`offer_id IS NULL`, written before offers existed) that the
 * shared resolver leaves unattributed because the brand names another offer
 * somewhere. In a CONVERSION it is attributed to the converting campaign's offer
 * when it is the ONLY ceiling of that channel and leg on the brand (any offer,
 * either leg spelling): nothing else could be its campaign. Two or more such
 * rows, or an offer-named row beside it, is ambiguous and refused (409
 * `ceiling_ambiguous`), never guessed. A leg-less row is never attributed here.
 */
function offerLessSoleCeiling(ceilings: CeilingRow[], key: ReplacedCeilingKey): CeilingRow[] {
  if (key.legKey === null) return [];
  const sameChannelLeg = ceilings.filter(
    (r) => r.featureSlug === key.featureSlug && r.legKey !== null && sameLeg(key.featureSlug, r.legKey, key.legKey)
  );
  const offerLess = sameChannelLeg.filter((r) => r.offerId === null);
  if (offerLess.length === 0) return [];
  if (sameChannelLeg.length > 1) {
    throw new FunnelConversionRefusedError(
      "ceiling_ambiguous",
      `${sameChannelLeg.length} ceilings fund ${key.featureSlug}|${key.legKey} on the brand, ${offerLess.length} of them with no offer: which one is this offer's cannot be told`,
      { key, ceilings: sameChannelLeg.length }
    );
  }
  return offerLess;
}

/**
 * CONVERSION (campaign-service turns a pre-funnel campaign family into a funnel
 * campaign): the named per-campaign ceilings of this brand x offer are DELETED
 * and the funnel's max budget takes their place, in the caller's transaction.
 * Refused (409, nothing written) unless it moves no figure beyond rounding:
 * the cap per day must equal the replaced ceilings' sum within one cent, the
 * cap must recur (a one_off cap would drop the brand's daily money), the brand
 * is not on a global sales budget, and the org is not a subscriber (its plan is
 * priced from those rows). Ceilings resolve with the same rule every read uses
 * (`campaignCeilingRows`: offer, channel, either leg spelling).
 */
async function convertCeilings(
  tx: Tx,
  k: FunnelCapKey,
  maxBudget: BudgetCapInput | null,
  keys: ReplacedCeilingKey[]
): Promise<CeilingConversion> {
  const [global] = await tx
    .select()
    .from(brandSalesBudgets)
    .where(and(eq(brandSalesBudgets.orgId, k.orgId), eq(brandSalesBudgets.brandId, k.brandId)))
    .limit(1);
  if (global) {
    throw new FunnelConversionRefusedError("brand_in_global_mode", "the brand is funded by one global sales budget, not per-campaign ceilings");
  }
  const [account] = await tx
    .select({ paymentMode: billingAccounts.paymentMode })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, k.orgId))
    .limit(1);
  if (account?.paymentMode === "subscription") {
    throw new FunnelConversionRefusedError("subscription_org", "a subscriber's plan is priced from its per-campaign rows; convert it once the plan reads funnel caps");
  }
  const ceilings = await tx
    .select()
    .from(campaignDailyBudgets)
    .where(and(eq(campaignDailyBudgets.orgId, k.orgId), eq(campaignDailyBudgets.brandId, k.brandId)))
    .for("update");
  const before = await getLegacyBrandDailyBudget(k.orgId, k.brandId, tx);
  const funnelBefore = await brandFunnelDailyCentsVia(tx, k.orgId, k.brandId);
  const picked = new Map<string, CeilingRow>();
  for (const key of keys) {
    let rows = campaignCeilingRows(ceilings, { offerId: k.offerId, featureSlug: key.featureSlug, legKey: key.legKey } as CampaignKey);
    if (rows.length === 0) rows = offerLessSoleCeiling(ceilings, key);
    if (rows.length === 0) {
      throw new FunnelConversionRefusedError("ceiling_not_found", `no ceiling funds ${key.featureSlug}|${key.legKey ?? ""} on offer ${k.offerId}`, { key });
    }
    for (const r of rows) picked.set(`${r.featureSlug}\u0000${r.offerId ?? ""}\u0000${r.legKey ?? ""}`, r);
  }
  const replaced = [...picked.values()];
  if (replaced.some((r) => r.monthlyBudgetCents != null || r.planDerived)) {
    throw new FunnelConversionRefusedError("subscriber_plan_rows", "a replaced ceiling carries a subscriber monthly budget");
  }
  const replacedDaily = replaced.reduce((s, r) => s.plus(r.dailyBudgetCents), new Decimal(0));
  const capDaily = maxBudget ? new Decimal(recurringDailyCentsOf({ maxBudgetCents: maxBudget.amountCents, maxBudgetPeriod: maxBudget.period })!) : new Decimal(0);
  if (capDaily.minus(replacedDaily).abs().greaterThan(CONVERSION_TOLERANCE_CENTS)) {
    throw new FunnelConversionRefusedError(
      "conversion_moves_budget",
      `the max budget is ${capDaily.toFixed(2)} cents a day but the replaced ceilings sum to ${replacedDaily.toFixed(2)}${maxBudget?.period === "one_off" ? " (a one_off cap is not daily money)" : ""}`,
      { capDailyCents: capDaily.toFixed(10), replacedDailyCents: replacedDaily.toFixed(10) }
    );
  }
  for (const r of replaced) {
    await tx
      .delete(campaignDailyBudgets)
      .where(
        and(
          eq(campaignDailyBudgets.orgId, k.orgId),
          eq(campaignDailyBudgets.brandId, k.brandId),
          eq(campaignDailyBudgets.featureSlug, r.featureSlug),
          r.offerId === null ? isNull(campaignDailyBudgets.offerId) : eq(campaignDailyBudgets.offerId, r.offerId),
          r.legKey === null ? isNull(campaignDailyBudgets.legKey) : eq(campaignDailyBudgets.legKey, r.legKey)
        )
      );
  }
  console.log(
    `[billing-service] funnel conversion: org=${k.orgId} brand=${k.brandId} offer=${k.offerId} funnel=${k.salesFunnelId} ` +
      `replaced ${replaced.length} ceiling(s) ${replacedDaily.toFixed(2)} cents/day with a cap of ${capDaily.toFixed(2)} cents/day`
  );
  return {
    replacedCeilings: replaced.map((r) => ({ featureSlug: r.featureSlug, offerId: r.offerId, legKey: r.legKey, dailyBudgetCents: r.dailyBudgetCents })),
    replacedDailyCents: replacedDaily.toFixed(10),
    capDailyCents: capDaily.toFixed(10),
    brandDailyBudgetBefore:
      before === null && funnelBefore === null ? null : new Decimal(before?.dailyBudgetCents ?? "0").plus(funnelBefore ?? "0").toFixed(10),
    brandDailyBudgetAfter: null,
  };
}


/**
 * Boot reconcile, idempotent: a brand whose recurring funnel caps were stated
 * BEFORE the by-day history learned about them (v0.83.10) gets one row, dated
 * now, carrying its current daily figure. A brand whose latest row already
 * says that figure gets nothing. Never throws (logged).
 */
export async function reconcileFunnelCapHistory(): Promise<void> {
  try {
    // First the TYPE of caps written before billing stored it (migration 0080),
    // so the daily figures below count a reactive funnel as 0.
    const untyped = await db
      .select()
      .from(salesFunnelCaps)
      .where(isNull(salesFunnelCaps.salesFunnelType));
    for (const row of untyped) {
      try {
        const funnel = await getSalesFunnel(row.salesFunnelId);
        if (!funnel.type) {
          console.error(`[billing-service] funnel cap type: features-service serves no type for ${row.salesFunnelId}, left unknown (counted as proactive)`);
          continue;
        }
        await db
          .update(salesFunnelCaps)
          .set({ salesFunnelType: funnel.type })
          .where(keyWhere(row));
        console.log(`[billing-service] funnel cap type: ${row.salesFunnelId} org=${row.orgId} -> ${funnel.type}`);
      } catch (err) {
        console.error(`[billing-service] funnel cap type of ${row.salesFunnelId} unreadable, retried next boot: ${(err as Error).message}`);
      }
    }
    const brands = await db
      .selectDistinct({ orgId: salesFunnelCaps.orgId, brandId: salesFunnelCaps.brandId })
      .from(salesFunnelCaps);
    for (const b of brands) {
      const current = await getBrandDailyBudget(b.orgId, b.brandId);
      if (!current) continue;
      const [latest] = await db
        .select()
        .from(brandDailyBudgetChanges)
        .where(and(eq(brandDailyBudgetChanges.orgId, b.orgId), eq(brandDailyBudgetChanges.brandId, b.brandId)))
        .orderBy(desc(brandDailyBudgetChanges.changedAt), desc(brandDailyBudgetChanges.id))
        .limit(1);
      if (latest?.dailyBudgetCents != null && cmpCents(latest.dailyBudgetCents, current.dailyBudgetCents) === 0) continue;
      await db.insert(brandDailyBudgetChanges).values({
        orgId: b.orgId,
        brandId: b.brandId,
        dailyBudgetCents: current.dailyBudgetCents,
        changedAt: new Date(),
      });
      console.log(
        `[billing-service] funnel cap history: brand=${b.brandId} org=${b.orgId} daily ${latest?.dailyBudgetCents ?? "none"} -> ${current.dailyBudgetCents}`
      );
    }
  } catch (err) {
    console.error("[billing-service] funnel cap history reconcile failed:", err);
  }
}

// ── Measurement ───────────────────────────────────────────────────────────────

export interface MeasuredPipe extends SalesFunnelPipe {
  /** The campaigns campaign-service states for this brand x offer on this pipe. */
  campaignIds: string[];
}

/**
 * A lead SOURCE feeding the funnel (Start -> Lead found). Not a leg of the sales
 * path, but the funnel's leads are bought there, so its spend is the funnel's
 * (owner 2026-10-09: a budget is ALL-INCLUSIVE, sourcing + sending + LLM).
 */
export interface MeasuredSource {
  /** The origin's feature slug (a features-service sourcing origin). */
  channelSlug: string;
  /** The published source leg (`start_to_lead_found`). */
  legKey: string;
  /** The funnel's pipes it feeds (`<channel>|<leg>`). */
  feedsPipeIds: string[];
  /** The source campaigns campaign-service states for this brand x offer on this origin. */
  campaignIds: string[];
}

type SourcesAnswer =
  | { ok: true; sources: MeasuredSource[] }
  | { ok: false; reason: ConsumedUnavailableReason; detail: string };

type PipesAnswer =
  | { ok: true; funnel: SalesFunnel; pipes: MeasuredPipe[]; sources: SourcesAnswer }
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
  const sources = await feedingSources(funnel, ofOffer);
  const pipes = funnel.pipes.map((p) => ({
    ...p,
    campaignIds: ofOffer
      .filter((c) => c.featureSlug === p.channelSlug && sameLeg(p.channelSlug, c.legKey, p.legKey))
      .map((c) => c.campaignId)
      .sort(),
  }));
  return { ok: true, funnel, pipes, sources };
}

/**
 * The lead sources feeding the funnel's pipes: features-service publishes which
 * origins feed which outreach channel (`/public/sourcing-origins`
 * `originsByChannel`) and the source leg; a source campaign is campaign-service's
 * campaign of this brand x offer on that origin and leg. One source feeding two
 * pipes is listed once. An unreadable catalogue is a REASON, never "no sources"
 * (that would under-count the spend and stop the funnel late).
 */
async function feedingSources(
  funnel: SalesFunnel,
  ofOffer: Array<{ campaignId: string; featureSlug: string | null; legKey: string | null }>
): Promise<SourcesAnswer> {
  let terms: SalesPathTerms;
  try {
    terms = await getSalesPathTerms();
  } catch (err) {
    console.error(`[billing-service] sales funnel caps: sourcing origins unreadable: ${(err as Error).message}`);
    return { ok: false, reason: "sourcing_catalogue_unavailable", detail: (err as Error).message };
  }
  const byOrigin = new Map<string, MeasuredSource>();
  for (const p of funnel.pipes) {
    for (const origin of terms.originsFeeding(p.channelSlug)) {
      const entry = byOrigin.get(origin) ?? { channelSlug: origin, legKey: "", feedsPipeIds: [], campaignIds: [] };
      entry.feedsPipeIds.push(p.pipeId);
      byOrigin.set(origin, entry);
    }
  }
  for (const src of byOrigin.values()) {
    const campaigns = ofOffer.filter((c) => c.featureSlug === src.channelSlug && terms.isSourceItem(src.channelSlug, c.legKey));
    src.campaignIds = campaigns.map((c) => c.campaignId).sort();
    src.legKey = campaigns[0]?.legKey ?? "start_to_lead_found";
  }
  return { ok: true, sources: [...byOrigin.values()].sort((a, b) => a.channelSlug.localeCompare(b.channelSlug)) };
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

const DISTINCT_PARENT_PAGE = 500;
const MAX_DISTINCT_PARENT_PAGES = 100;

/** Distinct PARENT runs of this task's runs (completed or in flight) on these campaigns since `start`. */
async function distinctParentsSince(
  orgId: string,
  campaignIds: string[],
  task: { serviceName: string; taskName: string },
  start: Date
): Promise<number> {
  const parents = new Set<string>();
  const seen = new Set<string>();
  for (let page = 0; ; page += 1) {
    if (page >= MAX_DISTINCT_PARENT_PAGES) {
      throw new Error(`runs-service ${task.serviceName}:${task.taskName} walk exceeded ${MAX_DISTINCT_PARENT_PAGES} pages`);
    }
    const data = await readJson<{ runs?: Array<{ id: string; parentRunId?: string | null; status?: string }> }>(
      "/v1/runs",
      orgId,
      new URLSearchParams({
        campaignIds: campaignIds.join(","),
        serviceName: task.serviceName,
        taskName: task.taskName,
        startedAfter: start.toISOString(),
        limit: String(DISTINCT_PARENT_PAGE),
        offset: String(page * DISTINCT_PARENT_PAGE),
      })
    );
    if (!Array.isArray(data.runs)) throw new Error("runs-service /v1/runs returned no runs array");
    for (const r of data.runs) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      if (r.status !== "completed" && r.status !== "running") continue;
      // A run with no parent is its own prospect.
      parents.add(r.parentRunId ?? r.id);
    }
    if (data.runs.length < DISTINCT_PARENT_PAGE) break;
  }
  return parents.size;
}

/** Items (completed + in flight) of these campaigns on one item task. */
async function itemsSince(
  orgId: string,
  campaignIds: string[],
  task: { serviceName: string; taskName: string; distinctParent?: true },
  start: Date
): Promise<number> {
  if (campaignIds.length === 0) return 0;
  if (task.distinctParent) return distinctParentsSince(orgId, campaignIds, task, start);
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
  /**
   * The cap's money PER DAY in every daily figure (brand daily budget, pace,
   * MRR, spendable totals): daily x1, weekly / 7, monthly / 30; "0" for a
   * one_off cap and for a REACTIVE funnel ("Up to $X" is a ceiling, owner rule
   * 2026-10-01). Read it; never recompute it.
   */
  dailyBudgetCents: string;
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
  /** What the count counts; null only when the funnel is unreadable. */
  unit: VolumeUnit | null;
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
  /** features-service's name of the funnel; null when unreadable. */
  salesFunnelName: string | null;
  /** features-service's served funnel type (relayed); null with a reason when not served/unreadable. */
  salesFunnelType: SalesFunnelType | null;
  salesFunnelTypeUnavailableReason: SalesFunnelTypeUnavailableReason | null;
  /** The unit a max volume of this funnel is counted in; null when the funnel is unreadable. */
  volumeUnit: VolumeUnit | null;
  /** The pipes measured and the campaigns found on each; null when not read or unreadable. */
  pipes: MeasuredPipe[] | null;
  /**
   * The lead sources feeding the pipes (their spend is in maxBudget.consumedCents);
   * null when not read, unreadable (see the budget's reason) or nothing stated.
   */
  sources: MeasuredSource[] | null;
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
    dailyBudgetCents: recurringDailyCentsOf(row)!,
    periodStart: w.start.toISOString(),
    periodEnd: w.end ? w.end.toISOString() : null,
    consumedCents: consumed ? fixed(consumed) : null,
    remainingCents: consumed ? fixed(Decimal.max(cap.minus(consumed), 0)) : null,
    reached: consumed ? consumed.greaterThanOrEqualTo(cap) : null,
    consumedUnavailableReason: m.reason,
    consumedUnavailableDetail: m.detail,
  };
}

function volumeView(row: SalesFunnelCapRow, now: Date, m: Measured<number>, unit: VolumeUnit | null): VolumeCapView | null {
  if (row.maxVolume == null || row.maxVolumePeriod == null || row.maxVolumeSince == null) return null;
  const period = row.maxVolumePeriod as CapPeriod;
  const w = periodWindow(period, row.maxVolumeSince, now);
  return {
    count: row.maxVolume,
    period,
    unit,
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

async function measureBudget(
  k: FunnelCapKey,
  row: SalesFunnelCapRow,
  pipes: MeasuredPipe[],
  sources: SourcesAnswer,
  now: Date
): Promise<Measured<string>> {
  // ALL-INCLUSIVE: the pipes' campaigns AND the lead sources feeding them.
  if (!sources.ok) return { consumed: null, reason: sources.reason, detail: sources.detail };
  const w = periodWindow(row.maxBudgetPeriod as CapPeriod, row.maxBudgetSince!, now);
  const ids = [...new Set([...pipes.flatMap((p) => p.campaignIds), ...sources.sources.flatMap((s) => s.campaignIds)])];
  try {
    return { consumed: await spendSince(k.orgId, ids, w.start), reason: null, detail: null };
  } catch (err) {
    console.error(`[billing-service] sales funnel caps: spend of ${k.salesFunnelId} unreadable: ${(err as Error).message}`);
    return { consumed: null, reason: "runs_service_unavailable", detail: (err as Error).message };
  }
}

async function measureVolume(k: FunnelCapKey, row: SalesFunnelCapRow, pipes: MeasuredPipe[], now: Date): Promise<Measured<number>> {
  // first_contacts: the proactive pipes; prospects_handled (all reactive): the reactive ones.
  const proactive = pipes.filter((p) => p.mode === "proactive");
  // A reactive funnel takes a prospect on at its FIRST pipe; the later pipes
  // handle that same prospect, so only the first is counted (never twice).
  const counted = proactive.length > 0 ? proactive : pipes.slice(0, 1);
  const tasks = proactive.length > 0 ? ITEM_TASKS : REACTIVE_ITEM_TASKS;
  if (counted.length === 0) {
    return { consumed: null, reason: "no_proactive_pipe", detail: `sales funnel ${k.salesFunnelId} has no pipe` };
  }
  const unmeasured = counted.filter((p) => !tasks[p.channelSlug]).map((p) => p.channelSlug);
  if (unmeasured.length > 0) {
    const what = proactive.length > 0 ? "first-contact" : "prospect-handled";
    return {
      consumed: null,
      reason: "volume_not_measured_on_channel",
      detail: `no ${what} measure on ${[...new Set(unmeasured)].join(", ")}`,
    };
  }
  const w = periodWindow(row.maxVolumePeriod as CapPeriod, row.maxVolumeSince!, now);
  // One read per item task: the campaigns of every counted pipe making it.
  const byTask = new Map<string, { task: { serviceName: string; taskName: string; distinctParent?: true }; ids: Set<string> }>();
  for (const p of counted) {
    const task = tasks[p.channelSlug];
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
    // Nothing stated: still name the funnel, its type and its volume unit (the form's labels).
    const read = await readFunnelSoft(k.salesFunnelId);
    return {
      ...k,
      stated: false,
      updatedAt: null,
      maxBudget: null,
      maxVolume: null,
      ...funnelIdentity(read.funnel, read.reason),
      pipes: null,
      sources: null,
    };
  }
  const answer = await measuredPipes(k);
  let budget: Measured<string> = NOT_MEASURED();
  let volume: Measured<number> = NOT_MEASURED();
  if (!answer.ok) {
    budget = { consumed: null, reason: answer.reason, detail: answer.detail };
    volume = { consumed: null, reason: answer.reason, detail: answer.detail };
  } else {
    [budget, volume] = await Promise.all([
      row.maxBudgetCents != null ? measureBudget(k, row, answer.pipes, answer.sources, now) : Promise.resolve(NOT_MEASURED<string>()),
      row.maxVolume != null ? measureVolume(k, row, answer.pipes, now) : Promise.resolve(NOT_MEASURED<number>()),
    ]);
  }
  return {
    ...k,
    stated: true,
    updatedAt: row.updatedAt.toISOString(),
    maxBudget: budgetView(row, now, budget),
    maxVolume: volumeView(row, now, volume, answer.funnel ? volumeUnitOf(answer.funnel) : null),
    ...funnelIdentity(answer.funnel, answer.ok ? null : answer.reason),
    pipes: answer.ok ? answer.pipes : null,
    sources: answer.ok && answer.sources.ok ? answer.sources.sources : null,
  };
}

/** The funnel read fail-soft: the funnel, or null with the reason it could not be read. */
async function readFunnelSoft(
  id: string
): Promise<{ funnel: SalesFunnel | null; reason: "sales_funnel_not_found" | "sales_funnel_catalogue_unavailable" | null }> {
  try {
    return { funnel: await getSalesFunnel(id), reason: null };
  } catch (err) {
    if (err instanceof SalesFunnelNotFoundError) return { funnel: null, reason: "sales_funnel_not_found" };
    console.error(`[billing-service] sales funnel caps: ${(err as Error).message}`);
    return { funnel: null, reason: "sales_funnel_catalogue_unavailable" };
  }
}

/**
 * PURE: the funnel's name, RELAYED type and volume unit. `readReason` is why the
 * funnel itself could not be read (a funnel read but a later read failing is not
 * a type problem).
 */
export function funnelIdentity(funnel: SalesFunnel | null, readReason: string | null) {
  const typeReason: SalesFunnelTypeUnavailableReason | null = funnel
    ? funnel.type
      ? null
      : "type_not_served_by_features_service"
    : readReason === "sales_funnel_not_found"
      ? "sales_funnel_not_found"
      : "sales_funnel_catalogue_unavailable";
  return {
    salesFunnelName: funnel?.name ?? null,
    salesFunnelType: funnel?.type ?? null,
    salesFunnelTypeUnavailableReason: typeReason,
    volumeUnit: funnel ? volumeUnitOf(funnel) : null,
  };
}

/**
 * The brand list waits at most this long on the catalogue: campaign-service reads
 * it for its budget figures, and a slow features-service must not slow that read
 * (the type then reads null + `sales_funnel_catalogue_unavailable`).
 */
const BRAND_LIST_CATALOGUE_WAIT_MS = 3_000;

/** The stated caps of a row, without measurement (the brand list), plus the funnel's relayed type + unit. */
export async function statedCapsOf(row: SalesFunnelCapRow) {
  let timer: NodeJS.Timeout | undefined;
  const read = await Promise.race([
    readFunnelSoft(row.salesFunnelId),
    new Promise<{ funnel: null; reason: "sales_funnel_catalogue_unavailable" }>((resolve) => {
      timer = setTimeout(
        () => resolve({ funnel: null, reason: "sales_funnel_catalogue_unavailable" }),
        BRAND_LIST_CATALOGUE_WAIT_MS
      );
    }),
  ]);
  clearTimeout(timer);
  const identity = funnelIdentity(read.funnel, read.reason);
  return {
    offerId: row.offerId,
    salesFunnelId: row.salesFunnelId,
    salesFunnelType: identity.salesFunnelType,
    salesFunnelTypeUnavailableReason: identity.salesFunnelTypeUnavailableReason,
    maxBudget:
      row.maxBudgetCents != null
        ? { amountCents: row.maxBudgetCents, period: row.maxBudgetPeriod as CapPeriod, dailyBudgetCents: recurringDailyCentsOf(row)! }
        : null,
    maxVolume:
      row.maxVolume != null
        ? { count: row.maxVolume, period: row.maxVolumePeriod as CapPeriod, unit: identity.volumeUnit }
        : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export { SalesFunnelCatalogueUnavailableError, SalesFunnelNotFoundError };
