/**
 * ITEM BUDGETS PER CAMPAIGN — "you choose, we run" (owner 2026-10-04, migrations
 * 0062 + 0063).
 *
 * A campaign is (offer x leg x channel). The customer states ONE budget per
 * campaign of an offer; two sales paths sharing a campaign share its budget, and a
 * campaign is unique by nature. billing holds the budgets and turns them into what
 * the customer pays:
 *
 *  - PERIOD follows the payment mode: a subscriber states MONTHLY budgets, a
 *    prepaid / postpaid org DAILY ones.
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
import {
  campaignItemBudgetChanges,
  campaignItemBudgets,
  salesPathReactiveCharges,
  brandDailyBudgetChanges,
  subscriptionCreditExpiries,
  type CampaignItemBudget,
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
  itemsDailyTotalCents,
  itemsPlanPricing,
  listBrandItems,
  listOfferItems,
  type CampaignOnPredicate,
  type ItemsPlanPricing,
} from "./campaign-items-store.js";
import { fetchRecurringCampaignStatuses } from "./campaign-service-client.js";
import { getBrandDailyBudget } from "./brand-budgets.js";
import { getPaymentMode } from "./payment-mode.js";
import {
  advanceSubscription,
  listLiveSubscriptions,
  reactiveCollectedInPeriod,
  syncPlanPricingFromItems,
} from "./subscription.js";
import { attributeUnassignedPlan } from "./subscription-plans.js";
import { reloadOffSession } from "./reload.js";

/** The acquirer refuses a charge under this; a smaller delta rolls into the renewal. */
const MIN_CHARGE_CENTS = 50;
const CHARGE_TIMEOUT_MS = 30_000;
/** A reactive budget is at most this share of the offer's entry budgets. */
export const REACTIVE_CAP_RATIO = 0.5;

export type ItemBudgetRefusalCode =
  | "invalid_items"
  | "duplicate_item"
  | "unknown_item"
  | "customer_leg_has_no_budget"
  | "amount_not_whole_cents"
  | "amount_not_whole_dollars"
  | "below_minimum"
  | "entry_item_required"
  | "reactive_above_cap"
  | "no_plan_for_offer"
  | "subscription_not_active"
  | "reactive_charge_declined"
  | "charge_unavailable"
  | "minimums_unavailable"
  | "campaign_status_unavailable";

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

export type ItemPeriod = "day" | "month";
export type ItemRoleServed = "proactive" | "reactive";

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

/** The largest MAX budget a reactive campaign may carry: half the offer's entry budgets. */
export function reactiveCapCents(entryBudgetsCents: number): number {
  return Math.floor(entryBudgetsCents * REACTIVE_CAP_RATIO);
}

function itemKey(featureSlug: string, legKey: string): string {
  return `${featureSlug}\u0000${legKey}`;
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
    out.push({ featureSlug: item.featureSlug, legKey: item.legKey, budgetCents: item.budgetCents, role: t.role });
  }
  return out;
}

/** Judge the offer's state once the write lands: every reactive MAX within half its entries. */
export function assertReactiveCaps(offer: OfferItem[], period: ItemPeriod): void {
  const entries = offer.filter((i) => i.role === "proactive").reduce((sum, i) => sum + i.budgetCents, 0);
  const reactive = offer.filter((i) => i.role === "reactive");
  if (reactive.length === 0) return;
  if (entries === 0) {
    throw new ItemBudgetRefused(
      "entry_item_required",
      "Set a budget on a campaign that finds the leads first; a follow-up campaign is capped at half of it.",
      400,
      { featureSlug: reactive[0].featureSlug, legKey: reactive[0].legKey }
    );
  }
  const capCents = reactiveCapCents(entries);
  for (const r of reactive) {
    if (r.budgetCents > capCents) {
      throw new ItemBudgetRefused(
        "reactive_above_cap",
        `${r.featureSlug} on ${r.legKey} can be at most half of the lead-finding budgets: ${dollars(capCents)}${per(period)}.`,
        400,
        { featureSlug: r.featureSlug, legKey: r.legKey, capCents, period }
      );
    }
  }
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

async function periodOf(orgId: string): Promise<ItemPeriod> {
  return (await getPaymentMode(orgId)) === "subscription" ? "month" : "day";
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

function asOfferItems(rows: CampaignItemBudget[]): OfferItem[] {
  return rows.map((r) => ({
    featureSlug: r.featureSlug,
    legKey: r.legKey,
    budgetCents: r.budgetCents,
    role: r.role as ItemRoleServed,
  }));
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
  userId: string | null;
  now?: Date;
}

/**
 * State (or restate) one or several campaign budgets of an offer. Refusals are
 * ItemBudgetRefused with a stable code; nothing is written on any refusal.
 */
export async function setOfferItems(params: SetOfferItemsParams): Promise<{ reactiveChargedCents: number }> {
  const brandId = params.brandId.toLowerCase();
  const offerId = params.offerId.toLowerCase();
  const { orgId } = params;
  const now = params.now ?? new Date();
  const period = await periodOf(orgId);
  const terms = await readTerms();
  const written = validateItemInputs(params.items, period, terms);

  const existing = await listOfferItems(orgId, brandId, offerId);
  const writtenKeys = new Set(written.map((i) => itemKey(i.featureSlug, i.legKey)));
  const offer = [
    ...asOfferItems(existing).filter((i) => !writtenKeys.has(itemKey(i.featureSlug, i.legKey))),
    ...written,
  ];
  assertReactiveCaps(offer, period);

  let plan: Subscription | null = null;
  let reactiveChargedCents = 0;
  if (period === "month") {
    ({ plan, reactiveChargedCents } = await subscriberGate(orgId, brandId, offerId, offer, terms, now));
  }

  await db.transaction(async (tx) => {
    for (const i of written) {
      await tx
        .insert(campaignItemBudgets)
        .values({
          orgId,
          brandId,
          offerId,
          featureSlug: i.featureSlug,
          legKey: i.legKey,
          role: i.role,
          period,
          budgetCents: i.budgetCents,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            campaignItemBudgets.orgId,
            campaignItemBudgets.brandId,
            campaignItemBudgets.offerId,
            campaignItemBudgets.featureSlug,
            campaignItemBudgets.legKey,
          ],
          set: { role: i.role, period, budgetCents: i.budgetCents, updatedAt: now },
        });
      await tx.insert(campaignItemBudgetChanges).values({
        orgId,
        brandId,
        offerId,
        featureSlug: i.featureSlug,
        legKey: i.legKey,
        budgetCents: i.budgetCents,
        period,
        changedByUserId: params.userId,
        changedAt: now,
      });
    }
  });

  await afterItemsChanged(orgId, brandId, plan, terms, now);
  return { reactiveChargedCents };
}

/**
 * Remove one campaign's budget (back to "not set"). Idempotent: false when nothing
 * was stored. Refused when it would leave a follow-up budget above its cap.
 */
export async function removeOfferItem(params: {
  orgId: string;
  brandId: string;
  offerId: string;
  featureSlug: string;
  legKey: string;
  userId: string | null;
  now?: Date;
}): Promise<boolean> {
  const brandId = params.brandId.toLowerCase();
  const offerId = params.offerId.toLowerCase();
  const { orgId, featureSlug, legKey } = params;
  const now = params.now ?? new Date();
  const existing = await listOfferItems(orgId, brandId, offerId);
  const target = existing.find((r) => r.featureSlug === featureSlug && r.legKey === legKey);
  if (!target) return false;
  const period = target.period as ItemPeriod;
  assertReactiveCaps(
    asOfferItems(existing).filter((i) => !(i.featureSlug === featureSlug && i.legKey === legKey)),
    period
  );
  await db.transaction(async (tx) => {
    await tx.delete(campaignItemBudgets).where(eq(campaignItemBudgets.id, target.id));
    await tx.insert(campaignItemBudgetChanges).values({
      orgId,
      brandId,
      offerId,
      featureSlug,
      legKey,
      budgetCents: null,
      period,
      changedByUserId: params.userId,
      changedAt: now,
    });
  });
  let terms: SalesPathTerms | null = null;
  try {
    terms = await getSalesPathTerms();
  } catch (err) {
    console.error("[billing-service] sales-path terms unreadable after a budget removal:", err);
  }
  const plan = (await periodOf(orgId)) === "month" ? await planFor(orgId, brandId, offerId) : null;
  await afterItemsChanged(orgId, brandId, plan, terms, now);
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
    const rows = await listOfferItems(orgId, brandId, offerId);
    if (rows.length === 0) return;
    let plan = await planFor(orgId, brandId, offerId);
    if (!plan) return;
    plan = await advanceSubscription(plan, now);
    if (plan.status === "canceled") return;
    const terms = await getSalesPathTerms();
    if (chargesReactiveNow(plan)) {
      const isOn = await readOnPredicate(orgId);
      await chargeReactiveDelta(plan, chargedReactiveMonthly(brandId, offerId, asOfferItems(rows), terms, isOn));
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

/** Re-price the plan and journal the brand's new daily total. */
async function afterItemsChanged(
  orgId: string,
  brandId: string,
  plan: Subscription | null,
  terms: SalesPathTerms | null,
  now: Date
): Promise<void> {
  if (plan && plan.status !== "canceled") await syncPlanPricingFromItems(plan, now);
  // The brand-total timeline (replayed by the by-day read) gets the new effective
  // total: the items' daily total, or, once the last budget is removed, whatever
  // the brand is back on (global pot / ceilings), when it has one.
  const rows = await listBrandItems(orgId, brandId);
  const total = rows.length > 0
    ? itemsDailyTotalCents(rows, terms)
    : (await getBrandDailyBudget(orgId, brandId))?.dailyBudgetCents ?? null;
  if (total !== null) {
    await db.insert(brandDailyBudgetChanges).values({ orgId, brandId, dailyBudgetCents: total, changedAt: now });
  }
}

// --- reads -----------------------------------------------------------------

export interface ItemView {
  featureSlug: string;
  legKey: string;
  role: ItemRoleServed | null;
  period: ItemPeriod;
  /** null = not set. A reactive budget is a MAX. */
  budgetCents: number | null;
  /** false = a channel we do not run yet: recorded, charged nothing. */
  managed: boolean | null;
  /** The minimum in this period. */
  minimumCents: number | null;
  /** For a reactive campaign: the most it may carry (half the offer's entry budgets). */
  capCents: number | null;
  /** Customer-team legs carry no budget. */
  budgetable: boolean;
  updatedAt: string | null;
}

export interface OfferItemsView {
  brandId: string;
  offerId: string;
  /** The period the org states budgets in now (subscription → month). */
  period: ItemPeriod;
  items: ItemView[];
  /** Subscriber: the offer's live plan and its pricing from the budgets; null otherwise. */
  plan: { subscriptionId: string; monthlyAmountCents: number } | null;
  /** Subscriber: what the budgets cost (null when nothing is charged, or not a subscriber). */
  pricing: ItemsPlanPricing | null;
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
  const rows = await listOfferItems(orgId, brandId, offerId);
  const terms = await readTerms();
  const entries = rows.filter((r) => r.role === "proactive").reduce((sum, r) => sum + r.budgetCents, 0);

  const pairs: Array<{ featureSlug: string; legKey: string }> = rows.map((r) => ({
    featureSlug: r.featureSlug,
    legKey: r.legKey,
  }));
  for (const c of campaigns) {
    if (!pairs.some((p) => p.featureSlug === c.featureSlug && p.legKey === c.legKey)) pairs.push(c);
  }
  const items: ItemView[] = pairs.map(({ featureSlug, legKey }) => {
    const row = rows.find((r) => r.featureSlug === featureSlug && r.legKey === legKey) ?? null;
    const t = terms.termsFor(featureSlug, legKey);
    const p = (row?.period as ItemPeriod | undefined) ?? period;
    const role: ItemRoleServed | null =
      (row?.role as ItemRoleServed | undefined) ?? (t && t.role !== "customer" ? t.role : null);
    return {
      featureSlug,
      legKey,
      role,
      period: p,
      budgetCents: row?.budgetCents ?? null,
      managed: t?.managed ?? null,
      minimumCents: t?.minimumMonthlyCents == null ? null : minimumInPeriod(t.minimumMonthlyCents, p),
      capCents: role === "reactive" ? reactiveCapCents(entries) : null,
      budgetable: t ? t.role !== "customer" : false,
      updatedAt: row ? row.updatedAt.toISOString() : null,
    };
  });

  let plan: OfferItemsView["plan"] = null;
  let pricing: ItemsPlanPricing | null = null;
  if (period === "month") {
    const live = (await listLiveSubscriptions(orgId)).find((s) => s.brandId === brandId && s.offerId === offerId);
    if (live) plan = { subscriptionId: live.id, monthlyAmountCents: live.monthlyAmountCents };
    if (rows.length > 0) pricing = itemsPlanPricing(rows, terms, await readOnPredicate(orgId));
  }
  return { brandId, offerId, period, items, plan, pricing };
}

/** One campaign as campaign-service spends it (GET /internal/brands/:id/sales-budget, mode "items"). */
export interface SpendItemView {
  offerId: string;
  legKey: string;
  featureSlug: string;
  role: ItemRoleServed;
  /** Decimal cents. A reactive monthly budget includes the carry-over from last period. */
  budgetCents: string;
  period: ItemPeriod;
  /** The plan's current period for a monthly budget; null for a daily one. */
  periodStart: string | null;
  periodEnd: string | null;
  /** false = a channel we do not run yet (never charged); null = catalogue unreadable. */
  managed: boolean | null;
}

export interface BrandItemsSpendView {
  items: SpendItemView[];
  /** Daily equivalent of the proactive budgets we run (day + month/30). */
  dailyBudgetCents: string;
  updatedAt: Date;
}

/** The brand's campaign budgets as campaign-service spends them; null when it holds none. */
export async function getBrandItemsSpendView(orgId: string, brandId: string): Promise<BrandItemsSpendView | null> {
  brandId = brandId.toLowerCase();
  const rows = await listBrandItems(orgId, brandId);
  if (rows.length === 0) return null;
  let terms: SalesPathTerms | null = null;
  try {
    terms = await getSalesPathTerms();
  } catch (err) {
    console.error(`[billing-service] sales-path terms unreadable for brand ${brandId}: items served with managed=null`, err);
  }
  const plans = rows.some((r) => r.period === "month")
    ? (await listLiveSubscriptions(orgId)).filter((s) => s.brandId === brandId)
    : [];
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
  // A monthly budget funds a campaign only through a live plan's current period;
  // with no plan it funds nothing and is not served (campaign-service holds the
  // whole brand on an incomplete monthly item).
  const served = rows.filter((r) => r.period === "day" || plans.some((p) => p.offerId === r.offerId));
  const items: SpendItemView[] = served.map((r) => {
    const plan = r.period === "month" ? plans.find((p) => p.offerId === r.offerId) ?? null : null;
    let budget = r.budgetCents;
    if (r.role === "reactive" && r.period === "month") {
      const carry = carryByOffer.get(r.offerId) ?? 0;
      const reactiveTotal = served
        .filter((x) => x.offerId === r.offerId && x.role === "reactive" && x.period === "month")
        .reduce((sum, x) => sum + x.budgetCents, 0);
      if (carry > 0 && reactiveTotal > 0) budget += (carry * r.budgetCents) / reactiveTotal;
    }
    return {
      offerId: r.offerId,
      legKey: r.legKey,
      featureSlug: r.featureSlug,
      role: r.role as ItemRoleServed,
      budgetCents: budget.toFixed(10),
      period: r.period as ItemPeriod,
      periodStart: plan ? plan.currentPeriodStart.toISOString() : null,
      periodEnd: plan ? plan.currentPeriodEnd.toISOString() : null,
      managed: terms ? terms.managedChannel(r.featureSlug) : null,
    };
  });
  return {
    items,
    dailyBudgetCents: itemsDailyTotalCents(rows, terms),
    updatedAt: rows.reduce((latest, r) => (r.updatedAt > latest ? r.updatedAt : latest), rows[0].updatedAt),
  };
}
