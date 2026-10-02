/**
 * The SaaS business in three figures, per org and fleet-wide (staff Revenue page).
 *
 *  1. RECURRING revenue — DRR (per day), MRR = DRR × 30, ARR = MRR × 12.
 *  2. ONE-OFF future revenue — money a prepaid org will spend and then stop.
 *  3. CASH FLOW — when money lands in the bank, which is a different thing: it is
 *     the charge schedule (lib/charge-schedule), summed and bucketed by date.
 *
 * WHO IS RECURRING (owner rule, 2026-09-29), decided on billing's own state:
 *
 *   - POSTPAID with a chargeable card        → recurring
 *   - PREPAID with auto top-up AND a chargeable card → recurring
 *   - PREPAID otherwise, still holding money → one_off (spends it, then stops)
 *   - everything else                        → none, with the reason
 *
 * "Chargeable card" = a payment method on file, in an issuing country that can
 * be charged off-session, and not called lost/stolen/closed by its issuer — the
 * same three facts the credit line (`resolvePostpaidTier`) and the payment
 * outlook read. A POSTPAID org without one is `none`: campaign-service stops
 * every campaign of an org the outlook reports `charge_blocked /
 * no_chargeable_card`, so it spends nothing more.
 *
 * WHAT A DAY IS WORTH — `proactiveDailyBudgetCents`, the same rule for every
 * class: the daily budgets of the org's PROACTIVE campaigns (entry legs) that
 * are running and whose audiences are not all exhausted. campaign-service states
 * that verdict per campaign (`recurring`); billing owns the amounts and matches
 * each campaign to its ceiling with the SAME resolver the ceiling read and write
 * use (`campaignCeilingRows`). Reactive legs never count — they fire from a step
 * and are a bonus. A brand in GLOBAL mode (one stated sales budget) counts that
 * amount whenever at least one of its campaigns is recurring; so does a legacy
 * brand-level scalar.
 *
 * UNKNOWN STAYS UNKNOWN. A campaign-service that cannot be read, or a campaign
 * whose verdict turns on an unknown axis while it holds a positive ceiling,
 * makes the org's figure NULL with a named reason — never 0, which would read as
 * a customer who stopped spending. Fleet totals sum the KNOWN rows and list the
 * unknown ones beside them, so every total is the sum of the rows shown.
 *
 * PURE READ: charges nothing, writes nothing, sends nothing. No discount: a
 * daily budget is configuration, and the usage modifier applies to charges only.
 */

import { Decimal } from "decimal.js";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, brandDailyBudgets } from "../db/schema.js";
import { getBrandSalesBudget } from "./brand-sales-budget.js";
import { campaignCeilingRows, getBrandCeilings, type CampaignKey } from "./campaign-budgets.js";
import {
  fetchRecurringCampaignStatuses,
  type RecurringCampaignStatus,
  type RecurringStatusUnavailableReason,
} from "./campaign-service-client.js";
import {
  chargeScheduleFrom,
  type ChargeSchedule,
  type ExpectedCharge,
} from "./charge-schedule.js";
import { fundedBrandIds, resolvePaymentOutlook } from "./payment-outlook.js";
import type { PaymentMode } from "./payment-mode-types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const MRR_DAYS = 30;
export const ARR_MONTHS = 12;
/** The projection horizons the Revenue page states. */
export const PROJECTION_HORIZONS_DAYS = [30, 90] as const;
export const DEFAULT_CASH_HORIZON_DAYS = 90;
export const MAX_CASH_HORIZON_DAYS = 366;
/** Concurrency of the fleet read: each org costs a handful of sibling reads. */
const FLEET_CONCURRENCY = 8;

export type RevenueClass = "recurring" | "one_off" | "none";

export type RevenueClassReason =
  | "postpaid_chargeable_card"
  | "prepaid_auto_topup"
  | "prepaid_no_auto_topup"
  | "prepaid_no_chargeable_card"
  | "postpaid_no_chargeable_card"
  | "prepaid_balance_spent"
  | "subscription"
  | "subscription_trialing"
  | "subscription_canceling"
  | "subscription_payment_failed"
  | "subscription_ended"
  | "subscription_not_started"
  /** Our own internal org (lib/platform-org): its spend is our cost, not revenue. */
  | "platform_org";

export type DailyBudgetUnknownReason =
  | RecurringStatusUnavailableReason
  /** A campaign holding a positive ceiling has no known recurring verdict. */
  | "campaign_recurrence_unknown";

export type RunOutUnknownReason = DailyBudgetUnknownReason | "no_proactive_spend";

export type BrandFundingMode = "global" | "campaigns" | "brand_scalar";

function fixed(d: Decimal): string {
  return d.toFixed(10);
}

/* ------------------------------------------------------------------ class */

export function classify(p: {
  paymentMode: PaymentMode;
  hasCardPm: boolean;
  autoReloadSupported: boolean;
  cardUnusable: boolean;
  autoTopupEnabled: boolean;
  balanceCents: string;
  /** Our own internal org (lib/platform-org). */
  platformOrg?: boolean;
  /** SUBSCRIPTION orgs: the subscription's state (null = never started). */
  subscription?: { status: string; cancelAtPeriodEnd: boolean } | null;
}): { revenueClass: RevenueClass; reason: RevenueClassReason; chargeableCard: boolean } {
  const chargeableCard = p.hasCardPm && p.autoReloadSupported && !p.cardUnusable;
  if (p.platformOrg) return { revenueClass: "none", reason: "platform_org", chargeableCard };
  if (p.paymentMode === "subscription") {
    // Owner rule (2026-10-01): a subscription's revenue is the plan we collect
    // every month, spent or not. Recurring only while ACTIVE with no cancel
    // pending: a trial has not paid yet (listed apart), a pending cancel is
    // churn, a refused renewal means payment stopped.
    const s = p.subscription ?? null;
    if (!s) return { revenueClass: "none", reason: "subscription_not_started", chargeableCard };
    if (s.status === "canceled") return { revenueClass: "none", reason: "subscription_ended", chargeableCard };
    if (s.status === "past_due") {
      return { revenueClass: "none", reason: "subscription_payment_failed", chargeableCard };
    }
    if (s.cancelAtPeriodEnd) return { revenueClass: "none", reason: "subscription_canceling", chargeableCard };
    if (s.status === "trialing") return { revenueClass: "none", reason: "subscription_trialing", chargeableCard };
    return { revenueClass: "recurring", reason: "subscription", chargeableCard };
  }
  if (p.paymentMode === "postpaid") {
    return chargeableCard
      ? { revenueClass: "recurring", reason: "postpaid_chargeable_card", chargeableCard }
      : { revenueClass: "none", reason: "postpaid_no_chargeable_card", chargeableCard };
  }
  if (chargeableCard && p.autoTopupEnabled) {
    return { revenueClass: "recurring", reason: "prepaid_auto_topup", chargeableCard };
  }
  if (new Decimal(p.balanceCents).lessThanOrEqualTo(0)) {
    return { revenueClass: "none", reason: "prepaid_balance_spent", chargeableCard };
  }
  return {
    revenueClass: "one_off",
    reason: p.autoTopupEnabled ? "prepaid_no_chargeable_card" : "prepaid_no_auto_topup",
    chargeableCard,
  };
}

/* ------------------------------------------------------ proactive budgets */

export interface RevenueCampaignLine {
  campaignId: string;
  brandId: string | null;
  offerId: string | null;
  legKey: string | null;
  featureSlug: string | null;
  running: boolean;
  kind: "proactive" | "reactive" | null;
  audience: "available" | "exhausted" | "not_recorded";
  /** campaign-service's verdict: counts toward recurring spend right now. */
  recurring: boolean | null;
  recurringUnknownReason: string | null;
  /** The ceiling funding this campaign (billing's resolver), null when none is stated. */
  dailyBudgetCents: string | null;
  /** Whether this campaign's money is in the org's proactive daily budget. */
  counted: boolean;
}

export interface RevenueBrandLine {
  brandId: string;
  mode: BrandFundingMode;
  /** Everything this brand has configured per day (global amount, ceiling sum or scalar). */
  configuredDailyBudgetCents: string;
  /** The proactive, running, not-exhausted share. Null when unknown. */
  proactiveDailyBudgetCents: string | null;
  unknownReason: DailyBudgetUnknownReason | null;
}

export interface ProactiveBudget {
  dailyBudgetCents: string | null;
  unknownReason: DailyBudgetUnknownReason | null;
  brands: RevenueBrandLine[];
  campaigns: RevenueCampaignLine[];
}

interface BrandFunding {
  brandId: string;
  salesCents: string | null;
  ceilings: Awaited<ReturnType<typeof getBrandCeilings>>;
  scalarCents: string | null;
}

/**
 * The proactive daily budget of one org, from its funding (billing's) and its
 * campaigns' verdicts (campaign-service's). Pure: the reads are the caller's.
 */
export function proactiveBudgetOf(
  funding: BrandFunding[],
  statuses: RecurringCampaignStatus[]
): Omit<ProactiveBudget, "unknownReason" | "dailyBudgetCents"> & {
  dailyBudgetCents: string | null;
  unknownReason: DailyBudgetUnknownReason | null;
} {
  const brands: RevenueBrandLine[] = [];
  const lines: RevenueCampaignLine[] = [];
  const fundedIds = new Set(funding.map((f) => f.brandId));

  for (const f of funding) {
    const own = statuses.filter((c) => c.brandId === f.brandId);
    const anyTrue = own.some((c) => c.recurring === true);
    const anyNull = own.some((c) => c.recurring === null);

    // One amount for the whole brand (global sales budget, or a legacy scalar):
    // it is spent when at least one campaign is recurring.
    const wholeBrand = f.salesCents ?? (f.ceilings.length === 0 ? f.scalarCents : null);
    if (wholeBrand !== null) {
      const amount = new Decimal(wholeBrand);
      const mode: BrandFundingMode = f.salesCents !== null ? "global" : "brand_scalar";
      let proactive: string | null;
      let unknownReason: DailyBudgetUnknownReason | null = null;
      if (amount.isZero() || anyTrue) proactive = fixed(anyTrue ? amount : new Decimal(0));
      else if (anyNull) {
        proactive = null;
        unknownReason = "campaign_recurrence_unknown";
      } else proactive = fixed(new Decimal(0));
      brands.push({
        brandId: f.brandId,
        mode,
        configuredDailyBudgetCents: fixed(amount),
        proactiveDailyBudgetCents: proactive,
        unknownReason,
      });
      for (const c of own) {
        lines.push(lineOf(c, null, c.recurring === true && amount.greaterThan(0)));
      }
      continue;
    }

    // Per-campaign ceilings: each campaign's money is the ceiling billing's own
    // resolver attributes to it. A ceiling row two campaigns resolve to is
    // counted once.
    const counted = new Set<string>();
    const unknown = new Set<string>();
    let total = new Decimal(0);
    for (const c of own) {
      const rows = c.featureSlug
        ? campaignCeilingRows(f.ceilings, {
            offerId: c.offerId,
            legKey: c.legKey,
            featureSlug: c.featureSlug,
          } as CampaignKey)
        : [];
      const amount = rows.reduce((s, r) => s.plus(r.dailyBudgetCents), new Decimal(0));
      const isCounted = c.recurring === true && rows.length > 0;
      for (const r of rows) {
        const k = `${r.featureSlug}|${r.offerId ?? ""}|${r.legKey ?? ""}`;
        if (c.recurring === true && !counted.has(k)) {
          counted.add(k);
          total = total.plus(r.dailyBudgetCents);
        } else if (c.recurring === null && new Decimal(r.dailyBudgetCents).greaterThan(0)) {
          unknown.add(k);
        }
      }
      lines.push(lineOf(c, rows.length > 0 ? fixed(amount) : null, isCounted));
    }
    const stillUnknown = [...unknown].some((k) => !counted.has(k));
    brands.push({
      brandId: f.brandId,
      mode: "campaigns",
      configuredDailyBudgetCents: fixed(
        f.ceilings.reduce((s, r) => s.plus(r.dailyBudgetCents), new Decimal(0))
      ),
      proactiveDailyBudgetCents: stillUnknown ? null : fixed(total),
      unknownReason: stillUnknown ? "campaign_recurrence_unknown" : null,
    });
  }

  // Campaigns of brands this org funds nothing for: listed, never counted.
  for (const c of statuses) {
    if (c.brandId === null || !fundedIds.has(c.brandId)) lines.push(lineOf(c, null, false));
  }

  let dailyBudgetCents: string | null = fixed(new Decimal(0));
  let unknownReason: DailyBudgetUnknownReason | null = null;
  for (const b of brands) {
    if (b.proactiveDailyBudgetCents === null) {
      dailyBudgetCents = null;
      unknownReason = b.unknownReason;
      break;
    }
    dailyBudgetCents = fixed(new Decimal(dailyBudgetCents!).plus(b.proactiveDailyBudgetCents));
  }
  return { dailyBudgetCents, unknownReason, brands, campaigns: lines };
}

function lineOf(
  c: RecurringCampaignStatus,
  dailyBudgetCents: string | null,
  counted: boolean
): RevenueCampaignLine {
  return {
    campaignId: c.campaignId,
    brandId: c.brandId,
    offerId: c.offerId,
    legKey: c.legKey,
    featureSlug: c.featureSlug,
    running: c.running,
    kind: c.kind,
    audience: c.audience,
    recurring: c.recurring,
    recurringUnknownReason: c.recurringUnknownReason ?? null,
    dailyBudgetCents,
    counted,
  };
}

async function readFunding(orgId: string): Promise<BrandFunding[]> {
  const brandIds = await fundedBrandIds(orgId);
  return Promise.all(
    brandIds.map(async (brandId) => {
      const [sales, ceilings, scalarRows] = await Promise.all([
        getBrandSalesBudget(orgId, brandId),
        getBrandCeilings(orgId, brandId),
        db
          .select({ dailyBudgetCents: brandDailyBudgets.dailyBudgetCents })
          .from(brandDailyBudgets)
          .where(and(eq(brandDailyBudgets.orgId, orgId), eq(brandDailyBudgets.brandId, brandId)))
          .limit(1),
      ]);
      return {
        brandId,
        salesCents: sales ? String(sales.dailyBudgetCents) : null,
        ceilings,
        scalarCents: scalarRows[0] ? String(scalarRows[0].dailyBudgetCents) : null,
      };
    })
  );
}

/**
 * campaign-service reads the channel catalogue from features-service on EVERY
 * recurring-status call, uncached. Measured on prod 2026-09-29: eight concurrent
 * fleet reads made 9 of 16 recurring orgs answer 502 `catalogue_unavailable`,
 * while the same calls one at a time answered 200 in ~300 ms. So these calls go
 * through at most two at a time, and a failed one is asked once more after a
 * short pause. Still fail-soft with the named reason if it keeps failing.
 */
const RECURRING_STATUS_CONCURRENCY = 2;
const RECURRING_STATUS_RETRY_MS = 750;
let recurringInFlight = 0;
const recurringWaiters: Array<() => void> = [];

async function recurringStatusesThrottled(orgId: string) {
  // A released slot is handed straight to the next waiter, so the count never
  // exceeds the cap even when a new caller arrives in between.
  if (recurringInFlight >= RECURRING_STATUS_CONCURRENCY) {
    await new Promise<void>((resolve) => recurringWaiters.push(resolve));
  } else {
    recurringInFlight += 1;
  }
  try {
    const first = await fetchRecurringCampaignStatuses(orgId);
    if (first.ok || first.reason !== "campaign_service_unavailable") return first;
    await new Promise((r) => setTimeout(r, RECURRING_STATUS_RETRY_MS));
    return await fetchRecurringCampaignStatuses(orgId);
  } finally {
    const next = recurringWaiters.shift();
    if (next) next();
    else recurringInFlight -= 1;
  }
}

export async function getProactiveBudget(orgId: string): Promise<ProactiveBudget> {
  const funding = await readFunding(orgId);
  // An org funding nothing has nothing to ask campaign-service about.
  if (funding.length === 0) {
    return { dailyBudgetCents: fixed(new Decimal(0)), unknownReason: null, brands: [], campaigns: [] };
  }
  const answer = await recurringStatusesThrottled(orgId);
  if (!answer.ok) {
    return { dailyBudgetCents: null, unknownReason: answer.reason, brands: [], campaigns: [] };
  }
  return proactiveBudgetOf(funding, answer.campaigns);
}

/* ------------------------------------------------------------ per org */

export interface ProjectedRevenue {
  horizonDays: number;
  /** DRR × days (0 unless recurring). Null when the DRR is unknown. */
  recurringCents: string | null;
  /** min(remaining, pace × days) for a one-off org, 0 otherwise. Null when unknown. */
  oneOffCents: string | null;
  totalCents: string | null;
}

export interface OneOffRevenue {
  /** What this org still holds and will spend (its spendable balance). */
  remainingCents: string;
  /** Proactive daily budget: the pace it spends at. Null when unknown. */
  dailyPaceCents: string | null;
  /** When the remaining money is spent at that pace. Null with a reason when never / unknown. */
  runOutAt: string | null;
  runOutUnknownReason: RunOutUnknownReason | null;
}

export interface RevenueSubscription {
  status: string;
  monthlyAmountCents: number;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
  currentPeriodEnd: string;
}

export interface OrgRevenue {
  orgId: string;
  asOf: string;
  paymentMode: PaymentMode;
  revenueClass: RevenueClass;
  classReason: RevenueClassReason;
  /** Inputs of the class, stated so a reader can check it. */
  chargeableCard: boolean;
  hasPaymentMethod: boolean;
  cardCountrySupported: boolean;
  cardUnusable: boolean;
  autoTopupEnabled: boolean;
  balanceCents: string;
  /** The proactive-campaign daily budget (the same rule for every class). */
  proactiveDailyBudgetCents: string | null;
  proactiveDailyBudgetUnknownReason: DailyBudgetUnknownReason | null;
  /** DRR: the proactive daily budget for a recurring org, "0" otherwise; null when unknown. */
  drrCents: string | null;
  mrrCents: string | null;
  arrCents: string | null;
  /** Present only for a one-off org. */
  oneOff: OneOffRevenue | null;
  /** SUBSCRIPTION orgs: the plan and its state (a trial is shown apart, not counted). */
  subscription: RevenueSubscription | null;
  projections: ProjectedRevenue[];
  /** The org's own charge schedule (lib/charge-schedule), unchanged. */
  cash: ChargeSchedule;
  brands: RevenueBrandLine[];
  campaigns: RevenueCampaignLine[];
}

function times(cents: string | null, n: number): string | null {
  return cents === null ? null : fixed(new Decimal(cents).times(n));
}

export async function getOrgRevenue(
  orgId: string,
  cashHorizonDays: number = DEFAULT_CASH_HORIZON_DAYS,
  now: Date = new Date()
): Promise<OrgRevenue | null> {
  const [resolved, proactive] = await Promise.all([
    resolvePaymentOutlook(orgId, now),
    getProactiveBudget(orgId),
  ]);
  if (!resolved) return null;
  return composeOrgRevenue(resolved, proactive, cashHorizonDays, now);
}

export function composeOrgRevenue(
  resolved: NonNullable<Awaited<ReturnType<typeof resolvePaymentOutlook>>>,
  proactive: ProactiveBudget,
  cashHorizonDays: number,
  now: Date
): OrgRevenue {
  const { outlook, inputs } = resolved;
  const cls = classify({
    paymentMode: outlook.paymentMode,
    hasCardPm: inputs.hasCardPm,
    autoReloadSupported: inputs.autoReloadSupported,
    cardUnusable: inputs.cardUnusable,
    autoTopupEnabled: inputs.autoTopupEnabled,
    balanceCents: inputs.balanceCents,
    platformOrg: inputs.platformOrg,
    subscription: inputs.subscription
      ? {
          status: inputs.subscription.sub.status,
          cancelAtPeriodEnd: inputs.subscription.sub.cancelAtPeriodEnd,
        }
      : null,
  });

  const pace = proactive.dailyBudgetCents;
  // A subscription's day is worth its plan / 30, whatever its campaigns spend.
  const subscriptionPlan = inputs.subscription ? inputs.subscription.sub.monthlyAmountCents : null;
  const drr =
    cls.revenueClass !== "recurring"
      ? fixed(new Decimal(0))
      : outlook.paymentMode === "subscription" && subscriptionPlan !== null
        ? fixed(new Decimal(subscriptionPlan).dividedBy(MRR_DAYS))
        : pace;

  let oneOff: OneOffRevenue | null = null;
  if (cls.revenueClass === "one_off") {
    const remaining = new Decimal(inputs.balanceCents);
    let runOutAt: string | null = null;
    let runOutUnknownReason: RunOutUnknownReason | null = null;
    if (pace === null) runOutUnknownReason = proactive.unknownReason;
    else if (new Decimal(pace).lessThanOrEqualTo(0)) runOutUnknownReason = "no_proactive_spend";
    else {
      const ms = remaining.dividedBy(pace).times(DAY_MS);
      runOutAt = new Date(now.getTime() + ms.toNumber()).toISOString();
    }
    oneOff = { remainingCents: fixed(remaining), dailyPaceCents: pace, runOutAt, runOutUnknownReason };
  }

  const projections = PROJECTION_HORIZONS_DAYS.map((days): ProjectedRevenue => {
    const recurringCents = times(drr, days);
    let oneOffCents: string | null = fixed(new Decimal(0));
    if (oneOff) {
      oneOffCents =
        pace === null
          ? null
          : fixed(Decimal.min(new Decimal(oneOff.remainingCents), new Decimal(pace).times(days)));
    }
    const totalCents =
      recurringCents === null || oneOffCents === null
        ? null
        : fixed(new Decimal(recurringCents).plus(oneOffCents));
    return { horizonDays: days, recurringCents, oneOffCents, totalCents };
  });

  // A subscription's MRR IS its plan, exactly (plan / 30 × 30 would lose a cent
  // to rounding).
  const mrr =
    cls.revenueClass === "recurring" && outlook.paymentMode === "subscription" && subscriptionPlan !== null
      ? fixed(new Decimal(subscriptionPlan))
      : times(drr, MRR_DAYS);
  return {
    orgId: outlook.orgId,
    asOf: now.toISOString(),
    paymentMode: outlook.paymentMode,
    revenueClass: cls.revenueClass,
    classReason: cls.reason,
    chargeableCard: cls.chargeableCard,
    hasPaymentMethod: inputs.hasCardPm,
    cardCountrySupported: inputs.autoReloadSupported,
    cardUnusable: inputs.cardUnusable,
    autoTopupEnabled: inputs.autoTopupEnabled,
    balanceCents: inputs.balanceCents,
    proactiveDailyBudgetCents: pace,
    proactiveDailyBudgetUnknownReason: proactive.unknownReason,
    drrCents: drr,
    mrrCents: mrr,
    arrCents: times(mrr, ARR_MONTHS),
    oneOff,
    subscription: inputs.subscription
      ? {
          status: inputs.subscription.sub.status,
          monthlyAmountCents: inputs.subscription.sub.monthlyAmountCents,
          cancelAtPeriodEnd: inputs.subscription.sub.cancelAtPeriodEnd,
          trialEndsAt: inputs.subscription.sub.trialEndsAt?.toISOString() ?? null,
          currentPeriodEnd: inputs.subscription.sub.currentPeriodEnd.toISOString(),
        }
      : null,
    projections,
    cash: chargeScheduleFrom(resolved, cashHorizonDays, now),
    brands: proactive.brands,
    campaigns: proactive.campaigns,
  };
}

/* ------------------------------------------------------------- fleet */

export interface CashBucket {
  /** UTC day (YYYY-MM-DD) or the Monday starting the ISO week. */
  start: string;
  /** Sum of the events with a known amount. */
  amountCents: string;
  eventCount: number;
  /** Events whose amount is unknown (unmeasured burn): never counted as 0. */
  unknownAmountEventCount: number;
}

export interface FleetRevenueRow {
  orgId: string;
  paymentMode: PaymentMode;
  revenueClass: RevenueClass;
  classReason: RevenueClassReason;
  chargeableCard: boolean;
  autoTopupEnabled: boolean;
  balanceCents: string;
  proactiveDailyBudgetCents: string | null;
  proactiveDailyBudgetUnknownReason: DailyBudgetUnknownReason | null;
  drrCents: string | null;
  mrrCents: string | null;
  arrCents: string | null;
  oneOff: OneOffRevenue | null;
  subscription: RevenueSubscription | null;
  projections: ProjectedRevenue[];
  cashState: ChargeSchedule["state"];
  cashBlockedReason: ChargeSchedule["blockedReason"];
  cashEvents: ExpectedCharge[];
}

export interface FleetTotalWindow {
  horizonDays: number;
  /** Sum of known per-org projections. */
  projectedRevenueCents: string;
  recurringCents: string;
  oneOffCents: string;
  unknownOrgIds: string[];
  /** Expected cash in the window: sum of every org's scheduled charges with a known amount. */
  cashCents: string;
  cashEventCount: number;
  unknownAmountCashEventCount: number;
}

export interface FleetRevenue {
  asOf: string;
  cashHorizonDays: number;
  accountCount: number;
  classCounts: Record<RevenueClass, number>;
  totals: {
    /** Sum of the known per-org DRRs (recurring orgs; others are 0). */
    drrCents: string;
    mrrCents: string;
    arrCents: string;
    /** Recurring orgs whose DRR is unknown, left out of the sums above. */
    drrUnknownOrgIds: string[];
    /** One-off money still to be spent, all one-off orgs. */
    oneOffRemainingCents: string;
    /** Subscriptions in their free trial: not revenue yet, shown apart. */
    subscriptionTrials: { count: number; monthlyAmountCents: string };
    windows: FleetTotalWindow[];
  };
  cashFlow: { byDay: CashBucket[]; byWeek: CashBucket[] };
  orgs: FleetRevenueRow[];
  /** Orgs whose read failed outright, with the error. Never silently dropped. */
  unreadableOrgs: { orgId: string; error: string }[];
}

function isoDay(at: string): string {
  return at.slice(0, 10);
}

function isoWeekStart(at: string): string {
  const d = new Date(`${isoDay(at)}T00:00:00.000Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(d.getTime() - dow * DAY_MS).toISOString().slice(0, 10);
}

export function bucketCash(
  events: ExpectedCharge[],
  keyOf: (at: string) => string
): CashBucket[] {
  const map = new Map<string, CashBucket>();
  for (const e of events) {
    const k = keyOf(e.at);
    const b = map.get(k) ?? { start: k, amountCents: "0", eventCount: 0, unknownAmountEventCount: 0 };
    b.eventCount += 1;
    if (e.expectedAmountCents === null) b.unknownAmountEventCount += 1;
    else b.amountCents = new Decimal(b.amountCents).plus(e.expectedAmountCents).toString();
    map.set(k, b);
  }
  return [...map.values()].sort((a, b) => a.start.localeCompare(b.start));
}

async function mapPool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

export function composeFleet(
  rows: OrgRevenue[],
  unreadable: { orgId: string; error: string }[],
  cashHorizonDays: number,
  now: Date
): FleetRevenue {
  const classCounts: Record<RevenueClass, number> = { recurring: 0, one_off: 0, none: 0 };
  let drr = new Decimal(0);
  let mrrSum = new Decimal(0);
  const drrUnknown: string[] = [];
  let oneOffRemaining = new Decimal(0);
  let trialCount = 0;
  let trialPlans = new Decimal(0);
  for (const r of rows) {
    if (r.classReason === "subscription_trialing" && r.subscription) {
      trialCount += 1;
      trialPlans = trialPlans.plus(r.subscription.monthlyAmountCents);
    }
    classCounts[r.revenueClass] += 1;
    if (r.drrCents === null) drrUnknown.push(r.orgId);
    else {
      drr = drr.plus(r.drrCents);
      mrrSum = mrrSum.plus(r.mrrCents ?? new Decimal(r.drrCents).times(MRR_DAYS));
    }
    if (r.oneOff) oneOffRemaining = oneOffRemaining.plus(r.oneOff.remainingCents);
  }

  const allEvents = rows.flatMap((r) => r.cash.events);
  const windows = PROJECTION_HORIZONS_DAYS.map((days): FleetTotalWindow => {
    const end = now.getTime() + days * DAY_MS;
    let projected = new Decimal(0);
    let recurring = new Decimal(0);
    let oneOff = new Decimal(0);
    const unknownOrgIds: string[] = [];
    for (const r of rows) {
      const p = r.projections.find((x) => x.horizonDays === days)!;
      if (p.totalCents === null) {
        unknownOrgIds.push(r.orgId);
        continue;
      }
      projected = projected.plus(p.totalCents);
      recurring = recurring.plus(p.recurringCents!);
      oneOff = oneOff.plus(p.oneOffCents!);
    }
    let cash = new Decimal(0);
    let count = 0;
    let unknownCash = 0;
    for (const e of allEvents) {
      if (new Date(e.at).getTime() > end) continue;
      count += 1;
      if (e.expectedAmountCents === null) unknownCash += 1;
      else cash = cash.plus(e.expectedAmountCents);
    }
    return {
      horizonDays: days,
      projectedRevenueCents: fixed(projected),
      recurringCents: fixed(recurring),
      oneOffCents: fixed(oneOff),
      unknownOrgIds,
      cashCents: cash.toString(),
      cashEventCount: count,
      unknownAmountCashEventCount: unknownCash,
    };
  });

  // Sum of the per-org MRRs (equal to DRR × 30 for budget-based orgs; exact for a
  // subscription's plan).
  const mrr = mrrSum;
  return {
    asOf: now.toISOString(),
    cashHorizonDays,
    accountCount: rows.length + unreadable.length,
    classCounts,
    totals: {
      drrCents: fixed(drr),
      mrrCents: fixed(mrr),
      arrCents: fixed(mrr.times(ARR_MONTHS)),
      drrUnknownOrgIds: drrUnknown,
      oneOffRemainingCents: fixed(oneOffRemaining),
      subscriptionTrials: { count: trialCount, monthlyAmountCents: fixed(trialPlans) },
      windows,
    },
    cashFlow: { byDay: bucketCash(allEvents, isoDay), byWeek: bucketCash(allEvents, isoWeekStart) },
    orgs: rows.map((r) => ({
      orgId: r.orgId,
      paymentMode: r.paymentMode,
      revenueClass: r.revenueClass,
      classReason: r.classReason,
      chargeableCard: r.chargeableCard,
      autoTopupEnabled: r.autoTopupEnabled,
      balanceCents: r.balanceCents,
      proactiveDailyBudgetCents: r.proactiveDailyBudgetCents,
      proactiveDailyBudgetUnknownReason: r.proactiveDailyBudgetUnknownReason,
      drrCents: r.drrCents,
      mrrCents: r.mrrCents,
      arrCents: r.arrCents,
      oneOff: r.oneOff,
      subscription: r.subscription,
      projections: r.projections,
      cashState: r.cash.state,
      cashBlockedReason: r.cash.blockedReason,
      cashEvents: r.cash.events,
    })),
    unreadableOrgs: unreadable,
  };
}

/**
 * Every billing account's revenue row, plus the totals and the cash flow. Each
 * org is read in isolation: one that cannot be read is LISTED as unreadable with
 * its error, never dropped and never counted as zero.
 */
export async function getFleetRevenue(
  cashHorizonDays: number = DEFAULT_CASH_HORIZON_DAYS,
  now: Date = new Date()
): Promise<FleetRevenue> {
  const accounts = await db.select({ orgId: billingAccounts.orgId }).from(billingAccounts);
  const orgIds = [...new Set(accounts.map((a) => a.orgId))];
  const unreadable: { orgId: string; error: string }[] = [];
  const results = await mapPool(orgIds, FLEET_CONCURRENCY, async (orgId) => {
    try {
      const r = await getOrgRevenue(orgId, cashHorizonDays, now);
      if (!r) unreadable.push({ orgId, error: "no billing account" });
      return r;
    } catch (err) {
      console.error(`[billing-service] fleet revenue read failed for org ${orgId}:`, err);
      unreadable.push({ orgId, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  });
  return composeFleet(
    results.filter((r): r is OrgRevenue => r !== null),
    unreadable,
    cashHorizonDays,
    now
  );
}
