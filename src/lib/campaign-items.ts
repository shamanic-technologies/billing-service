/**
 * ITEM BUDGETS PER CAMPAIGN — "you choose, we run" (owner 2026-10-04, migrations
 * 0062 + 0063).
 *
 * A campaign is (offer x leg x channel). The customer states ONE budget per
 * campaign of an offer; two sales paths sharing a campaign share its budget, and a
 * campaign is unique by nature. billing holds the budgets and turns them into what
 * the customer pays:
 *
 *  - PERIOD: a subscriber states MONTHLY budgets; a prepaid / postpaid org states
 *    DAILY ones by default and may state any campaign MONTHLY (owner 2026-10-05: a
 *    spend cap over the UTC calendar month, money still from the balance, nothing
 *    charged by the budget itself).
 *  - Every campaign clears its own MINIMUM, published per (channel x leg) by
 *    features-service (lib/sales-path-terms; a daily budget clears the monthly
 *    floor over 30 days, rounded up). Never hard-coded here.
 *  - A REACTIVE campaign (a leg out of a step a lead reaches) carries a MAX budget
 *    of at most 50% of the offer's ENTRY budgets — the SUM of its proactive
 *    campaigns, since a reactive leg fires on leads every entry brings. An offer
 *    with no entry budget takes no reactive one. A customer-team leg (your-team-*)
 *    carries no budget at all.
 *  - ON / OFF is NOT billing's: it is campaign-service's campaign status (the
 *    customer's statement of intent). An OFF campaign keeps its budget here; it
 *    spends nothing (campaign-service) and is charged nothing (below). No campaign
 *    yet = off.
 *  - SUBSCRIBER: the offer's plan is priced as the SUM of its monthly budgets on
 *    channels we run whose campaign is ON (at least $99), from the next charge
 *    (subscription.syncPlanPricingFromItems). A raise of the ON REACTIVE part is
 *    charged NOW for the current period (sales_path_reactive_charges, delta over
 *    what the period already collected for reactive budgets) — on a budget write,
 *    and when campaign-service reports a campaign turned on. Unspent reactive
 *    credit carries over at the boundary instead of expiring.
 *  - A channel we do NOT run yet: the budget is recorded and NOTHING is charged; it
 *    enters the plan at the first renewal after features-service marks it as run.
 *  - prepaid / postpaid: daily budgets charge nothing by themselves; spend is
 *    collected through the existing balance, reload and month-end rules.
 *
 * A brand with no item reads exactly as before (global / campaigns mode).
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { canonicalLegKey, legIdentityKey, sameLeg } from "./leg-identity.js";
import {
  campaignDailyBudgets,
  salesPathReactiveCharges,
  brandDailyBudgetChanges,
  subscriptionCreditExpiries,
  type CeilingRow,
  type Subscription,
} from "../db/schema.js";
import {
  DAYS_PER_MONTH,
  SalesPathTermsUnavailableError,
  getSalesPathTerms,
  type SalesPathTerms,
} from "./sales-path-terms.js";
import {
  campaignOnPredicateOf,
  holdsMonthlyBudget,
  itemOf,
  itemsPlanPricing,
  listBrandCeilingRows,
  listOfferItems,
  roleOf,
  type CampaignItem,
  type CampaignOnPredicate,
  type ItemPeriod,
  type ItemRoleServed,
  type ItemsPlanPricing,
} from "./campaign-items-store.js";
import {
  fetchRecurringCampaignStatuses,
  type RecurringStatusUnavailableReason,
} from "./campaign-service-client.js";
import { getBrandSalesBudget, clearBrandSalesBudget } from "./brand-sales-budget.js";
import { setCampaignDailyBudget, sumCeilings, type SetCampaignBudgetResult } from "./campaign-budgets.js";
import { getPaymentMode } from "./payment-mode.js";
import {
  advanceSubscription,
  listLiveSubscriptions,
  reactiveCollectedInPeriod,
  syncPlanPricingFromItems,
} from "./subscription.js";
import { attributeUnassignedPlan } from "./subscription-plans.js";
import { reloadOffSession } from "./reload.js";
import { splitOf } from "./campaign-sourcing.js";

/** The acquirer refuses a charge under this; a smaller delta rolls into the renewal. */
const MIN_CHARGE_CENTS = 50;
const CHARGE_TIMEOUT_MS = 30_000;

export type ItemBudgetRefusalCode =
  | "invalid_items"
  | "duplicate_item"
  | "unknown_item"
  | "customer_leg_has_no_budget"
  | "amount_not_whole_cents"
  | "amount_not_whole_dollars"
  | "below_minimum"
  | "entry_item_required"
  | "no_plan_for_offer"
  | "subscription_not_active"
  | "reactive_charge_declined"
  | "charge_unavailable"
  | "minimums_unavailable"
  | "campaign_status_unavailable"
  | "period_not_allowed";

export class ItemBudgetRefused extends Error {
  readonly code: ItemBudgetRefusalCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  constructor(
    code: ItemBudgetRefusalCode,
    message: string,
    status = 400,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ItemBudgetRefused";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type { ItemPeriod, ItemRoleServed } from "./campaign-items-store.js";

export interface ItemInput {
  featureSlug: string;
  legKey: string;
  budgetCents: number;
}

/** One campaign's budget, as the offer will hold it once a write lands. */
interface OfferItem {
  featureSlug: string;
  legKey: string;
  budgetCents: number;
  role: ItemRoleServed;
  /** A SOURCE campaign (a sourcing origin): finds leads, contacts nobody. */
  source?: boolean;
  /** Derived from the plan (lib/subscriber-plan-budgets): never charged on top of it. */
  planDerived?: boolean;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function per(period: ItemPeriod): string {
  return period === "day" ? "/day" : "/month";
}

/** The minimum in the item's own period: the monthly floor, or its 30th rounded up. */
export function minimumInPeriod(monthlyMinimumCents: number, period: ItemPeriod): number {
  return period === "month" ? monthlyMinimumCents : Math.ceil(monthlyMinimumCents / DAYS_PER_MONTH);
}

/** (channel, leg IDENTITY): either spelling of an outbound leg is one item. */
function itemKey(featureSlug: string, legKey: string): string {
  return legIdentityKey(featureSlug, legKey);
}

/**
 * Judge the ITEMS being written against the published terms. Pure; throws
 * ItemBudgetRefused. Returns each with its role.
 */
export function validateItemInputs(
  items: ItemInput[],
  period: ItemPeriod,
  terms: SalesPathTerms
): OfferItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ItemBudgetRefused("invalid_items", "State at least one campaign budget.");
  }
  const seen = new Set<string>();
  const out: OfferItem[] = [];
  for (const item of items) {
    const label = `${item.featureSlug} on ${item.legKey}`;
    const where = { featureSlug: item.featureSlug, legKey: item.legKey };
    const k = itemKey(item.featureSlug, item.legKey);
    if (seen.has(k)) {
      throw new ItemBudgetRefused("duplicate_item", `${label} is listed twice.`, 400, where);
    }
    seen.add(k);
    const t = terms.termsFor(item.featureSlug, item.legKey);
    if (!t) {
      throw new ItemBudgetRefused("unknown_item", `${label} is not a channel and leg we know.`, 400, where);
    }
    if (t.role === "customer") {
      throw new ItemBudgetRefused(
        "customer_leg_has_no_budget",
        `${label} is run by your own team, so it carries no budget.`,
        400,
        where
      );
    }
    if (t.minimumMonthlyCents === null || t.managed === null) {
      throw new ItemBudgetRefused(
        "minimums_unavailable",
        `We cannot read the minimum budget for ${label} right now, so nothing was saved. Try again in a moment.`,
        502,
        where
      );
    }
    if (!Number.isInteger(item.budgetCents) || item.budgetCents <= 0) {
      throw new ItemBudgetRefused(
        "amount_not_whole_cents",
        `The budget for ${label} must be a positive whole number of cents.`,
        400,
        where
      );
    }
    if (period === "month" && item.budgetCents % 100 !== 0) {
      throw new ItemBudgetRefused(
        "amount_not_whole_dollars",
        `A monthly budget is in whole dollars (${label}).`,
        400,
        where
      );
    }
    const minimumCents = minimumInPeriod(t.minimumMonthlyCents, period);
    if (item.budgetCents < minimumCents) {
      throw new ItemBudgetRefused(
        "below_minimum",
        `${label} needs at least ${dollars(minimumCents)}${per(period)}.`,
        400,
        { ...where, minimumCents, period }
      );
    }
    out.push({
      featureSlug: item.featureSlug,
      legKey: canonicalLegKey(item.featureSlug, item.legKey),
      budgetCents: item.budgetCents,
      role: t.role,
      source: t.source,
    });
  }
  return out;
}

/**
 * Judge the offer's state once the write lands: a follow-up (reactive) campaign
 * needs an entry budget to follow up on: an OUTREACH entry, never a source campaign
 * alone (a source finds leads and contacts nobody). There is NO maximum on any
 * budget (owner 2026-10-05: "people can put the numbers they want with no maximum,
 * only minimums apply"); the per channel x leg minimums are judged per item.
 */
export function assertEntryForReactive(offer: OfferItem[]): void {
  const reactive = offer.filter((i) => i.role === "reactive");
  if (reactive.length === 0) return;
  if (offer.some((i) => i.role === "proactive" && !i.source && i.budgetCents > 0)) return;
  throw new ItemBudgetRefused(
    "entry_item_required",
    "Set a budget on a campaign that finds the leads first; a follow-up campaign follows up on its leads.",
    400,
    { featureSlug: reactive[0].featureSlug, legKey: reactive[0].legKey }
  );
}

async function readTerms(): Promise<SalesPathTerms> {
  try {
    return await getSalesPathTerms();
  } catch (err) {
    if (err instanceof SalesPathTermsUnavailableError) {
      throw new ItemBudgetRefused(
        "minimums_unavailable",
        "We cannot read the minimum budgets right now, so nothing was saved. Try again in a moment.",
        502
      );
    }
    throw err;
  }
}

async function readOnPredicate(orgId: string): Promise<CampaignOnPredicate> {
  const statuses = await fetchRecurringCampaignStatuses(orgId);
  if (!statuses.ok) {
    throw new ItemBudgetRefused(
      "campaign_status_unavailable",
      "We cannot read which campaigns are on right now, so nothing was saved. Try again in a moment.",
      502
    );
  }
  return campaignOnPredicateOf(statuses.campaigns);
}

/** The org's DEFAULT period: a subscriber states months, prepaid / postpaid days. */
async function periodOf(orgId: string): Promise<ItemPeriod> {
  return (await getPaymentMode(orgId)) === "subscription" ? "month" : "day";
}

/**
 * The period a prepaid / postpaid MONTHLY budget covers: the UTC calendar month
 * `now` falls in (a subscriber's monthly budget covers its plan's period instead).
 */
export function calendarMonthOf(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

/** The live plan of this brand x offer (an unattributed onboarding plan is attributed first). */
async function planFor(orgId: string, brandId: string, offerId: string): Promise<Subscription | null> {
  await attributeUnassignedPlan(orgId);
  const live = await listLiveSubscriptions(orgId);
  return live.find((s) => s.brandId === brandId && s.offerId === offerId) ?? null;
}

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`reactive charge timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** Can this plan be charged a reactive budget right now? (active, running, not ending) */
function chargesReactiveNow(plan: Subscription): boolean {
  return plan.status === "active" && !plan.pausedAt && !plan.cancelAtPeriodEnd;
}

/** The ON reactive monthly budgets on channels we run: what the period must collect. */
function chargedReactiveMonthly(
  brandId: string,
  offerId: string,
  offer: OfferItem[],
  terms: SalesPathTerms,
  isOn: CampaignOnPredicate
): number {
  return offer
    .filter(
      (i) =>
        i.role === "reactive" &&
        !i.planDerived &&
        terms.managedChannel(i.featureSlug) === true &&
        isOn({ brandId, offerId, featureSlug: i.featureSlug, legKey: i.legKey })
    )
    .reduce((sum, i) => sum + i.budgetCents, 0);
}

/**
 * Charge NOW the reactive budget this period has not collected yet. Keyed on
 * (plan, period, target total) so a retried write collapses onto one charge.
 * Returns the cents charged (0 when nothing was due).
 */
async function chargeReactiveDelta(plan: Subscription, targetReactiveCents: number): Promise<number> {
  const collected = await reactiveCollectedInPeriod(plan);
  const delta = targetReactiveCents - collected;
  if (delta < MIN_CHARGE_CENTS) return 0;
  // CLAIM the charge first, once per (plan, period, target): a concurrent trigger
  // finds the claim and charges nothing. A failed claim may be re-claimed.
  const claimKey = and(
    eq(salesPathReactiveCharges.subscriptionId, plan.id),
    eq(salesPathReactiveCharges.periodStart, plan.currentPeriodStart),
    eq(salesPathReactiveCharges.cumulativeCents, targetReactiveCents)
  );
  let [claim] = await db
    .insert(salesPathReactiveCharges)
    .values({
      orgId: plan.orgId,
      subscriptionId: plan.id,
      periodStart: plan.currentPeriodStart,
      cumulativeCents: targetReactiveCents,
      amountCents: delta,
      status: "pending",
    })
    .onConflictDoNothing({
      target: [
        salesPathReactiveCharges.subscriptionId,
        salesPathReactiveCharges.periodStart,
        salesPathReactiveCharges.cumulativeCents,
      ],
    })
    .returning({ id: salesPathReactiveCharges.id });
  if (!claim) {
    [claim] = await db
      .update(salesPathReactiveCharges)
      .set({ status: "pending", amountCents: delta, failureCode: null })
      .where(and(claimKey, eq(salesPathReactiveCharges.status, "failed")))
      .returning({ id: salesPathReactiveCharges.id });
  }
  if (!claim) return 0; // already paid, or another trigger is charging it right now

  const key = `reactive:${plan.id}:${plan.currentPeriodStart.toISOString()}:${targetReactiveCents}`;
  let outcome;
  try {
    outcome = await withTimeout(
      CHARGE_TIMEOUT_MS,
      reloadOffSession(plan.orgId, delta, key, {
        reason: "subscription_reactive_items",
        subscription_id: plan.id,
        period_start: plan.currentPeriodStart.toISOString(),
      })
    );
  } catch (err) {
    await db
      .update(salesPathReactiveCharges)
      .set({ status: "failed", failureCode: "unavailable" })
      .where(eq(salesPathReactiveCharges.id, claim.id));
    console.error(`[billing-service] reactive budget charge for org ${plan.orgId} could not be attempted:`, err);
    throw new ItemBudgetRefused(
      "charge_unavailable",
      "The card could not be charged right now, so nothing was saved. Try again in a moment.",
      502
    );
  }
  const succeeded = outcome.status === "succeeded";
  await db
    .update(salesPathReactiveCharges)
    .set({
      status: succeeded ? "paid" : "failed",
      reference: outcome.reference ?? null,
      failureCode: succeeded ? null : outcome.failure_code ?? "declined",
    })
    .where(eq(salesPathReactiveCharges.id, claim.id));
  if (!succeeded) {
    throw new ItemBudgetRefused(
      "reactive_charge_declined",
      outcome.failure_message ?? "The card refused the charge for the follow-up budgets, so nothing was saved.",
      409,
      { amountCents: delta }
    );
  }
  console.log(`[billing-service] reactive budgets: org ${plan.orgId} charged ${delta} cents now on plan ${plan.id}`);
  return delta;
}

/** A budget stated in one period, expressed in another (30 days a month). */
export function inPeriod(cents: number, from: ItemPeriod, to: ItemPeriod): number {
  if (from === to) return cents;
  return to === "month" ? cents * DAYS_PER_MONTH : cents / DAYS_PER_MONTH;
}

/** The offer's stored budgets, each in the PERIOD being written (a day row read as 30 days in a month write). */
function asOfferItems(items: CampaignItem[], period: ItemPeriod, terms: SalesPathTerms): OfferItem[] {
  return items.map((i) => {
    const budget = inPeriod(i.budgetCents, i.period, period);
    return {
      featureSlug: i.featureSlug,
      legKey: i.legKey,
      budgetCents: budget,
      role: roleOf(terms, i.featureSlug, i.legKey) ?? "proactive",
      source: terms.isSourceItem(i.featureSlug, i.legKey),
      planDerived: i.planDerived,
    };
  });
}

/**
 * For a subscriber: the live, chargeable plan of the offer (refusals named), plus
 * the reactive charge NOW for the offer state given.
 */
async function subscriberGate(
  orgId: string,
  brandId: string,
  offerId: string,
  offer: OfferItem[],
  terms: SalesPathTerms,
  now: Date
): Promise<{ plan: Subscription; reactiveChargedCents: number }> {
  let plan = await planFor(orgId, brandId, offerId);
  if (plan) plan = await advanceSubscription(plan, now);
  if (!plan || plan.status === "canceled") {
    throw new ItemBudgetRefused(
      "no_plan_for_offer",
      "This offer has no plan yet. Start a plan for it, then set its budgets.",
      409
    );
  }
  if (plan.status === "past_due") {
    throw new ItemBudgetRefused(
      "subscription_not_active",
      "The last payment did not go through; budgets can be changed once it has.",
      409
    );
  }
  let reactiveChargedCents = 0;
  if (chargesReactiveNow(plan)) {
    const isOn = await readOnPredicate(orgId);
    reactiveChargedCents = await chargeReactiveDelta(
      plan,
      chargedReactiveMonthly(brandId, offerId, offer, terms, isOn)
    );
  }
  return { plan, reactiveChargedCents };
}

export interface SetOfferItemsParams {
  orgId: string;
  brandId: string;
  offerId: string;
  items: ItemInput[];
  /**
   * The period the listed budgets are stated in; absent = the org's default (month
   * for a subscriber, day otherwise). A prepaid / postpaid org may state "month"; a
   * subscriber may not state "day".
   */
  period?: ItemPeriod;
  now?: Date;
}

export interface SetOfferItemsResult {
  reactiveChargedCents: number;
  /** true when the write took the brand out of its global sales budget. */
  globalBudgetCleared: boolean;
  /** The ceilings before the first write and after the last (the staff email composes from them). */
  previousCeilings: CeilingRow[];
  ceilings: CeilingRow[];
  previousBrandDailyBudgetCents: string | null;
  brandDailyBudgetCents: string;
}

/**
 * State (or restate) one or several campaign budgets of an offer, on the ONE store
 * per campaign (its ceiling row). Refusals are ItemBudgetRefused with a stable
 * code; nothing is written on any refusal.
 */
export async function setOfferItems(params: SetOfferItemsParams): Promise<SetOfferItemsResult> {
  const brandId = params.brandId.toLowerCase();
  const offerId = params.offerId.toLowerCase();
  const { orgId } = params;
  const now = params.now ?? new Date();
  const orgPeriod = await periodOf(orgId);
  const subscriber = orgPeriod === "month";
  const period = params.period ?? orgPeriod;
  if (subscriber && period === "day") {
    throw new ItemBudgetRefused(
      "period_not_allowed",
      "This organization pays by plan, so its campaign budgets are monthly.",
      400,
      { period }
    );
  }
  const terms = await readTerms();
  const written = validateItemInputs(params.items, period, terms);

  const writtenKeys = new Set(written.map((i) => itemKey(i.featureSlug, i.legKey)));
  const offer = [
    ...asOfferItems(await listOfferItems(orgId, brandId, offerId), period, terms).filter(
      (i) => !writtenKeys.has(itemKey(i.featureSlug, i.legKey))
    ),
    ...written,
  ];
  assertEntryForReactive(offer);

  let plan: Subscription | null = null;
  let reactiveChargedCents = 0;
  if (subscriber) {
    ({ plan, reactiveChargedCents } = await subscriberGate(orgId, brandId, offerId, offer, terms, now));
  }

  // Choosing campaigns replaces "we pick for you": the brand leaves the global pot.
  let globalBudgetCleared = false;
  if (await getBrandSalesBudget(orgId, brandId)) {
    globalBudgetCleared = (await clearBrandSalesBudget(orgId, brandId)).cleared;
  }

  let first: SetCampaignBudgetResult | null = null;
  let last: SetCampaignBudgetResult | null = null;
  for (const i of written) {
    const result = await setCampaignDailyBudget(
      orgId,
      brandId,
      { offerId, legKey: i.legKey, featureSlug: i.featureSlug },
      period === "month" ? (i.budgetCents / DAYS_PER_MONTH).toFixed(10) : i.budgetCents,
      { skipChannelFloor: true, monthlyBudgetCents: period === "month" ? i.budgetCents : null }
    );
    first ??= result;
    last = result;
  }
  if (plan && plan.status !== "canceled") await syncPlanPricingFromItems(plan, now);
  return {
    reactiveChargedCents,
    globalBudgetCleared,
    previousCeilings: first!.previousCeilings,
    ceilings: last!.ceilings,
    previousBrandDailyBudgetCents: first!.previousBrandDailyBudgetCents,
    brandDailyBudgetCents: last!.brandDailyBudgetCents,
  };
}

/**
 * Remove one campaign's budget (back to "not set": its ceiling row is deleted).
 * Idempotent: false when nothing was stored. Refused when it would leave a
 * follow-up budget with no lead-finding budget to follow up on.
 */
export async function removeOfferItem(params: {
  orgId: string;
  brandId: string;
  offerId: string;
  featureSlug: string;
  legKey: string;
  now?: Date;
}): Promise<boolean> {
  const brandId = params.brandId.toLowerCase();
  const offerId = params.offerId.toLowerCase();
  const { orgId, featureSlug, legKey } = params;
  const now = params.now ?? new Date();
  const items = await listOfferItems(orgId, brandId, offerId);
  const isTarget = (i: { featureSlug: string; legKey: string }) =>
    i.featureSlug === featureSlug && sameLeg(featureSlug, i.legKey, legKey);
  const target = items.find(isTarget);
  if (!target) return false;
  const terms = await readTerms();
  assertEntryForReactive(asOfferItems(items, target.period, terms).filter((i) => !isTarget(i)));
  await db.transaction(async (tx) => {
    await tx
      .delete(campaignDailyBudgets)
      .where(
        and(
          eq(campaignDailyBudgets.orgId, orgId),
          eq(campaignDailyBudgets.brandId, brandId),
          eq(campaignDailyBudgets.offerId, offerId),
          eq(campaignDailyBudgets.featureSlug, featureSlug),
          // The row as STORED (either spelling of the leg names it).
          eq(campaignDailyBudgets.legKey, target.legKey)
        )
      );
    const left = await tx
      .select()
      .from(campaignDailyBudgets)
      .where(and(eq(campaignDailyBudgets.orgId, orgId), eq(campaignDailyBudgets.brandId, brandId)));
    // The brand total timeline (the by-day replay) follows, unless the brand is on a global pot.
    if (!(await getBrandSalesBudget(orgId, brandId))) {
      await tx.insert(brandDailyBudgetChanges).values({
        orgId,
        brandId,
        dailyBudgetCents: sumCeilings(left),
        changedAt: now,
      });
    }
  });
  if (target.period === "month" && (await periodOf(orgId)) === "month") {
    const plan = await planFor(orgId, brandId, offerId);
    if (plan && plan.status !== "canceled") await syncPlanPricingFromItems(plan, now);
  }
  return true;
}

/**
 * campaign-service reports a campaign turned ON or OFF (a person's start / stop,
 * POST /internal/brands/:brandId/mission-status-changed). For a subscriber the
 * offer's plan is re-priced and, on ON, its follow-up budgets not yet collected
 * this period are charged now. Never throws: the campaign move already happened,
 * and a charge that fails here is collected with the next renewal (loudly logged).
 */
export async function onCampaignStatusChanged(params: {
  orgId: string;
  brandId: string;
  offerId: string | null;
  now?: Date;
}): Promise<void> {
  const { orgId } = params;
  const brandId = params.brandId.toLowerCase();
  const offerId = params.offerId?.toLowerCase() ?? null;
  const now = params.now ?? new Date();
  try {
    if (!offerId || (await periodOf(orgId)) !== "month") return;
    const items = (await listOfferItems(orgId, brandId, offerId)).filter((i) => i.period === "month");
    if (items.length === 0) return;
    let plan = await planFor(orgId, brandId, offerId);
    if (!plan) return;
    plan = await advanceSubscription(plan, now);
    if (plan.status === "canceled") return;
    const terms = await getSalesPathTerms();
    if (chargesReactiveNow(plan)) {
      const isOn = await readOnPredicate(orgId);
      await chargeReactiveDelta(
        plan,
        chargedReactiveMonthly(brandId, offerId, asOfferItems(items, "month", terms), terms, isOn)
      );
    }
    await syncPlanPricingFromItems(plan, now);
  } catch (err) {
    console.error(
      `[billing-service] campaign status change: could not re-price org ${orgId} brand ${brandId} offer ${offerId} ` +
        "(follow-up budgets are collected at the next renewal):",
      err
    );
  }
}

// --- reads -----------------------------------------------------------------

export interface ItemView {
  featureSlug: string;
  legKey: string;
  role: ItemRoleServed | null;
  /**
   * The period every figure of the row is in. A subscriber: always month. A prepaid /
   * postpaid org: the period the budget was stated in (a $90/month row reads
   * $90/month, its minimum in month too); not set = day.
   */
  period: ItemPeriod;
  /**
   * The period the budget was STATED in; null = not set. Differs from `period` for
   * a subscriber's row not yet restated (a legacy daily ceiling, served x30).
   */
  statedPeriod: ItemPeriod | null;
  /** null = not set. In `period`; a reactive budget is a MAX. */
  budgetCents: number | null;
  /** The daily ceiling campaign-service paces on (decimal string); null = not set. */
  dailyBudgetCents: string | null;
  /** DAILY: what outreach may spend (the whole daily ceiling when not split); null = not set. */
  outreachDailyBudgetCents: string | null;
  /** DAILY: what sourcing may spend, on demand, out of the daily ceiling; null = not split / not set. */
  sourcingCeilingCents: string | null;
  /** true when the campaign states a sourcing ceiling. */
  split: boolean;
  /**
   * true for a SOURCE campaign (featureSlug = a sourcing origin, legKey = the source
   * leg): its whole budget is sourcing, "up to $X/day". Never split.
   */
  source: boolean;
  /** false = a channel we do not run yet: recorded, charged nothing. */
  managed: boolean | null;
  /** The minimum in this period. */
  minimumCents: number | null;
  /** Always null: no budget has a maximum (owner 2026-10-05). Kept for readers of the old shape. */
  capCents: null;
  /** Customer-team legs carry no budget. */
  budgetable: boolean;
  updatedAt: string | null;
}

/** A row's daily split (lib/campaign-sourcing), or the explicit "not set" answer. */
function splitFieldsOf(row: CampaignItem | null) {
  if (!row) return { outreachDailyBudgetCents: null, sourcingCeilingCents: null, split: false };
  const s = splitOf([row]);
  return { outreachDailyBudgetCents: s.outreachDailyBudgetCents, sourcingCeilingCents: s.sourcingCeilingCents, split: s.split };
}

export interface OfferItemsView {
  brandId: string;
  offerId: string;
  /** The org's DEFAULT period (subscription → month, else day); each row carries its own. */
  period: ItemPeriod;
  items: ItemView[];
  /** Subscriber: the offer's live plan; null otherwise. */
  plan: { subscriptionId: string; monthlyAmountCents: number } | null;
  /** Subscriber: what the budgets cost (null when nothing is charged, or not a subscriber). */
  pricing: ItemsPlanPricing | null;
  /**
   * What the offer is committed to RIGHT NOW, in `period`: proactive spend and
   * reactive ceilings of the campaigns that are ON. Null when campaign-service
   * could not say which are on (`totalsUnavailableReason`), never a guessed 0.
   */
  totals: OfferBudgetTotals | null;
  totalsUnavailableReason: RecurringStatusUnavailableReason | null;
}

/** One reaction type: the reactive campaigns that fire on the same step. */
export interface ReactiveTriggerTotal {
  /** The step they react on (catalogue `from.key`, e.g. `conversation`); null = not published. */
  triggerKey: string | null;
  /** Its label (`Positive reply`); null = not published. */
  triggerLabel: string | null;
  /** SUM of their ceilings, in the totals' period. A MAX, never spend. */
  maxBudgetCents: number;
  campaigns: number;
}

export interface OfferBudgetTotals {
  /** The org's period (subscriber: month, else day); every figure below is in it. */
  period: ItemPeriod;
  proactive: {
    /** SUM of the budgets of the ON proactive campaigns: what the offer spends. */
    budgetCents: number;
    /** The part of it that is sourcing, on demand (source campaigns + split sourcing ceilings). */
    sourcingBudgetCents: number;
    campaigns: number;
  };
  reactive: {
    /** SUM of the ceilings of the ON reactive campaigns. A MAX, never counted as spend. */
    maxBudgetCents: number;
    campaigns: number;
    byTrigger: ReactiveTriggerTotal[];
  };
  /**
   * ON campaigns holding a budget that neither total counts: `role_unknown` (the
   * catalogue does not carry the channel x leg), `channel_not_run` (a channel we do
   * not run yet: recorded, spends nothing).
   */
  notCounted: Array<{ featureSlug: string; legKey: string; reason: "role_unknown" | "channel_not_run" }>;
}

/**
 * The offer's totals from its stored budgets. Pure. Only ON campaigns count (on/off
 * is campaign-service's status); each budget is taken in the item's period and
 * converted to `period`.
 */
export function offerBudgetTotals(
  stored: CampaignItem[],
  terms: SalesPathTerms,
  isOn: CampaignOnPredicate,
  period: ItemPeriod
): OfferBudgetTotals {
  const totals: OfferBudgetTotals = {
    period,
    proactive: { budgetCents: 0, sourcingBudgetCents: 0, campaigns: 0 },
    reactive: { maxBudgetCents: 0, campaigns: 0, byTrigger: [] },
    notCounted: [],
  };
  for (const i of stored) {
    if (!isOn(i)) continue;
    const t = terms.termsFor(i.featureSlug, i.legKey);
    const role = roleOf(terms, i.featureSlug, i.legKey);
    if (!role) {
      if (t?.role !== "customer") totals.notCounted.push({ featureSlug: i.featureSlug, legKey: i.legKey, reason: "role_unknown" });
      continue;
    }
    if (t?.managed === false) {
      totals.notCounted.push({ featureSlug: i.featureSlug, legKey: i.legKey, reason: "channel_not_run" });
      continue;
    }
    const budget = inPeriod(i.budgetCents, i.period, period);
    if (role === "proactive") {
      totals.proactive.budgetCents += budget;
      totals.proactive.campaigns += 1;
      if (terms.isSourceItem(i.featureSlug, i.legKey)) {
        totals.proactive.sourcingBudgetCents += budget;
      } else if (i.sourcingCeilingCents !== null) {
        totals.proactive.sourcingBudgetCents += inPeriod(Number(i.sourcingCeilingCents), "day", period);
      }
      continue;
    }
    totals.reactive.maxBudgetCents += budget;
    totals.reactive.campaigns += 1;
    const triggerKey = t?.trigger?.key ?? null;
    let bucket = totals.reactive.byTrigger.find((b) => b.triggerKey === triggerKey);
    if (!bucket) {
      bucket = { triggerKey, triggerLabel: t?.trigger?.label ?? null, maxBudgetCents: 0, campaigns: 0 };
      totals.reactive.byTrigger.push(bucket);
    }
    bucket.maxBudgetCents += budget;
    bucket.campaigns += 1;
  }
  return totals;
}

/**
 * The offer's campaign budgets. `campaigns` (optional) lists (featureSlug, legKey)
 * pairs the caller wants a row for even when nothing is stored ("not set").
 */
export async function getOfferItemsView(
  orgId: string,
  brandId: string,
  offerId: string,
  campaigns: Array<{ featureSlug: string; legKey: string }> = []
): Promise<OfferItemsView> {
  brandId = brandId.toLowerCase();
  offerId = offerId.toLowerCase();
  const period = await periodOf(orgId);
  const stored = await listOfferItems(orgId, brandId, offerId);
  const terms = await readTerms();

  const pairs: Array<{ featureSlug: string; legKey: string }> = stored.map((r) => ({
    featureSlug: r.featureSlug,
    legKey: r.legKey,
  }));
  // A pair asked under the other spelling of a stored outbound leg IS that row:
  // served once, under the new spelling (wave 2, lib/leg-identity).
  const samePair = (a: { featureSlug: string; legKey: string }, b: { featureSlug: string; legKey: string }) =>
    a.featureSlug === b.featureSlug && sameLeg(a.featureSlug, a.legKey, b.legKey);
  for (const c of campaigns) {
    if (!pairs.some((p) => samePair(p, c))) pairs.push({ featureSlug: c.featureSlug, legKey: canonicalLegKey(c.featureSlug, c.legKey) });
  }
  const items: ItemView[] = pairs.map(({ featureSlug, legKey }) => {
    const row = stored.find((r) => samePair(r, { featureSlug, legKey })) ?? null;
    const t = terms.termsFor(featureSlug, legKey);
    const role = roleOf(terms, featureSlug, legKey);
    // Every figure of a row is in ONE period, never a budget beside a cap or minimum
    // in another unit. A subscriber's rows are all monthly (a legacy daily ceiling is
    // converted x30 and flagged by statedPeriod); a prepaid / postpaid row is served
    // in the period it was stated in.
    const rowPeriod: ItemPeriod = period === "month" ? "month" : row?.period ?? "day";
    return {
      featureSlug,
      legKey,
      role,
      period: rowPeriod,
      statedPeriod: row?.period ?? null,
      budgetCents: row ? inPeriod(row.budgetCents, row.period, rowPeriod) : null,
      dailyBudgetCents: row?.dailyBudgetCents ?? null,
      ...splitFieldsOf(row),
      source: terms.isSourceItem(featureSlug, legKey),
      managed: t?.managed ?? null,
      minimumCents: t?.minimumMonthlyCents == null ? null : minimumInPeriod(t.minimumMonthlyCents, rowPeriod),
      capCents: null,
      budgetable: t ? t.role !== "customer" : false,
      updatedAt: row ? row.updatedAt.toISOString() : null,
    };
  });

  // ONE read of which campaigns are on, shared by the plan pricing and the totals.
  const statuses = stored.length > 0 ? await fetchRecurringCampaignStatuses(orgId) : null;
  const isOn: CampaignOnPredicate | null =
    statuses === null ? () => false : statuses.ok ? campaignOnPredicateOf(statuses.campaigns) : null;

  let plan: OfferItemsView["plan"] = null;
  let pricing: ItemsPlanPricing | null = null;
  if (period === "month") {
    const live = (await listLiveSubscriptions(orgId)).find((s) => s.brandId === brandId && s.offerId === offerId);
    if (live) plan = { subscriptionId: live.id, monthlyAmountCents: live.monthlyAmountCents };
    if (stored.some((i) => i.period === "month")) {
      if (!isOn) {
        throw new ItemBudgetRefused(
          "campaign_status_unavailable",
          "We cannot read which campaigns are on right now, so nothing was saved. Try again in a moment.",
          502
        );
      }
      pricing = itemsPlanPricing(stored, terms, isOn);
    }
  }
  const totals = isOn ? offerBudgetTotals(stored, terms, isOn, period) : null;
  const totalsUnavailableReason = statuses && !statuses.ok ? statuses.reason : null;
  if (totalsUnavailableReason) {
    console.error(
      `[billing-service] offer ${offerId} budget totals unavailable for org ${orgId}: ${totalsUnavailableReason}`
    );
  }
  return { brandId, offerId, period, items, plan, pricing, totals, totalsUnavailableReason };
}

/** One campaign as campaign-service spends it (GET /internal/brands/:id/sales-budget, mode "items"). */
export interface SpendItemView {
  offerId: string;
  legKey: string;
  featureSlug: string;
  /** null when the published catalogue does not carry the (channel, leg). */
  role: ItemRoleServed | null;
  /** Decimal cents in the period. A reactive monthly budget includes last period's carry-over. */
  budgetCents: string;
  /** DAILY: what outreach may spend (the whole daily ceiling when not split). */
  outreachDailyBudgetCents: string;
  /** DAILY: what sourcing may spend, on demand; null = not split. */
  sourcingCeilingCents: string | null;
  split: boolean;
  /** true for a SOURCE campaign (a sourcing origin on the source leg); null = catalogue unreadable. */
  source: boolean | null;
  period: ItemPeriod;
  /**
   * The period a monthly budget covers (a subscriber: its plan's current period; a
   * prepaid / postpaid org: the UTC calendar month); null for a daily one.
   */
  periodStart: string | null;
  periodEnd: string | null;
  /** false = a channel we do not run yet (never charged); null = catalogue unreadable. */
  managed: boolean | null;
}

export interface BrandItemsSpendView {
  items: SpendItemView[];
  /** The brand total: the sum of its daily ceilings (a monthly budget as its 30th). */
  dailyBudgetCents: string;
  updatedAt: Date;
}

/**
 * The brand's campaign budgets as campaign-service spends them in "items" mode —
 * only for a brand holding a subscriber's monthly budget; null otherwise (the
 * brand reads exactly as before: its ceilings in campaigns mode, or the global pot).
 */
export async function getBrandItemsSpendView(
  orgId: string,
  brandId: string,
  now: Date = new Date()
): Promise<BrandItemsSpendView | null> {
  brandId = brandId.toLowerCase();
  const rows = await listBrandCeilingRows(orgId, brandId);
  if (!holdsMonthlyBudget(rows)) return null;
  let terms: SalesPathTerms | null = null;
  try {
    terms = await getSalesPathTerms();
  } catch (err) {
    console.error(`[billing-service] sales-path terms unreadable for brand ${brandId}: items served with managed=null`, err);
  }
  const all = rows.map(itemOf).filter((i): i is CampaignItem => i !== null);
  const plans = (await listLiveSubscriptions(orgId)).filter((s) => s.brandId === brandId);
  const carryByOffer = new Map<string, number>();
  for (const plan of plans) {
    const [row] = await db
      .select({ carried: subscriptionCreditExpiries.carriedOverCents })
      .from(subscriptionCreditExpiries)
      .where(
        and(
          eq(subscriptionCreditExpiries.subscriptionId, plan.id),
          eq(subscriptionCreditExpiries.boundaryAt, plan.currentPeriodStart)
        )
      )
      .limit(1);
    if (row && plan.offerId) carryByOffer.set(plan.offerId, Number(row.carried));
  }
  // A subscriber's monthly budget funds a campaign only through a live plan's
  // current period; with no plan it funds nothing and is not served (campaign-service
  // holds the whole brand on an incomplete monthly item). A prepaid / postpaid
  // monthly budget covers the UTC calendar month.
  const subscriber = (await getPaymentMode(orgId)) === "subscription";
  const month = calendarMonthOf(now);
  const served = all.filter(
    (i) => i.period === "day" || !subscriber || plans.some((p) => p.offerId === i.offerId)
  );
  const reactive = (i: CampaignItem) => roleOf(terms, i.featureSlug, i.legKey) === "reactive";
  const items: SpendItemView[] = served.map((i) => {
    const plan = i.period === "month" && subscriber ? plans.find((p) => p.offerId === i.offerId) ?? null : null;
    const window = plan
      ? { start: plan.currentPeriodStart, end: plan.currentPeriodEnd }
      : i.period === "month"
        ? month
        : null;
    let budget = i.budgetCents;
    if (i.period === "month" && reactive(i)) {
      const carry = carryByOffer.get(i.offerId) ?? 0;
      const reactiveTotal = served
        .filter((x) => x.offerId === i.offerId && x.period === "month" && reactive(x))
        .reduce((sum, x) => sum + x.budgetCents, 0);
      if (carry > 0 && reactiveTotal > 0) budget += (carry * i.budgetCents) / reactiveTotal;
    }
    return {
      offerId: i.offerId,
      legKey: i.legKey,
      featureSlug: i.featureSlug,
      role: roleOf(terms, i.featureSlug, i.legKey),
      budgetCents: budget.toFixed(10),
      outreachDailyBudgetCents: splitOf([i]).outreachDailyBudgetCents,
      sourcingCeilingCents: splitOf([i]).sourcingCeilingCents,
      split: splitOf([i]).split,
      source: terms ? terms.isSourceItem(i.featureSlug, i.legKey) : null,
      period: i.period,
      periodStart: window ? window.start.toISOString() : null,
      periodEnd: window ? window.end.toISOString() : null,
      managed: terms ? terms.managedChannel(i.featureSlug) : null,
    };
  });
  return {
    items,
    dailyBudgetCents: sumCeilings(rows),
    updatedAt: rows.reduce((latest, r) => (r.updatedAt > latest ? r.updatedAt : latest), rows[0].updatedAt),
  };
}
