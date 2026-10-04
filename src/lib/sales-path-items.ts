/**
 * SALES-PATH ITEM BUDGETS — "you choose, we run" (owner 2026-10-04, migration 0062).
 *
 * A customer ACTIVATES sales paths on an offer (brand-service owns which, keyed on
 * features-service's `combinationKey`), then states ONE budget per (channel x leg)
 * ITEM of each path. billing holds those budgets and turns them into what the
 * customer pays:
 *
 *  - PERIOD follows the payment mode: a subscriber states MONTHLY budgets, a
 *    prepaid / postpaid org DAILY ones.
 *  - Every item clears its own MINIMUM, published per (channel x leg) by
 *    features-service (lib/sales-path-terms; a daily item clears the monthly floor
 *    over 30 days). Never hard-coded here.
 *  - A path has exactly ONE entry (proactive) item. A REACTIVE item (a leg out of a
 *    step a lead reaches) is at most 50% of that entry item. A customer-team leg
 *    (your-team-*) carries no budget at all.
 *  - At most one active path per ENTRY (channel x entry leg) per offer: a write
 *    whose entry belongs to another path is refused (409 entry_taken) unless the
 *    caller names that path in `replacePathKey`, which removes it in the same
 *    transaction.
 *  - SUBSCRIBER: the plan for that brand x offer is priced as the SUM of its items
 *    on channels we run (at least $99), from the next charge
 *    (subscription.syncPlanPricingFromItems; it replaces the $29+ picker for a
 *    brand that uses items). A raise of the REACTIVE part is charged NOW for the
 *    current period (sales_path_reactive_charges; delta over what the period
 *    already collected for reactive items), and the unspent reactive credit carries
 *    over at the boundary instead of expiring (subscription.expireAt).
 *  - A channel we do NOT run yet: the commitment is recorded (card on file, the
 *    row exists) and NOTHING is charged: it enters the plan the first renewal after
 *    features-service marks the channel as run.
 *  - prepaid / postpaid: daily items charge nothing by themselves; spend is
 *    collected through the existing balance, reload and month-end rules.
 *
 * A brand with no item reads exactly as before (global / campaigns mode).
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  salesPathItemBudgetChanges,
  salesPathItemBudgets,
  salesPathReactiveCharges,
  brandDailyBudgetChanges,
  subscriptionCreditExpiries,
  type SalesPathItemBudget,
  type Subscription,
} from "../db/schema.js";
import {
  DAYS_PER_MONTH,
  SalesPathTermsUnavailableError,
  getSalesPathTerms,
  type SalesPathTerms,
} from "./sales-path-terms.js";
import {
  itemsDailyTotalCents,
  itemsPlanPricing,
  listBrandItems,
  listOfferItems,
  spendableItemsOf,
  type ItemsPlanPricing,
} from "./sales-path-items-store.js";
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
/** A reactive item is at most this share of its path's entry item. */
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
  | "one_entry_item_per_path"
  | "reactive_above_cap"
  | "entry_taken"
  | "no_plan_for_offer"
  | "subscription_not_active"
  | "reactive_charge_declined"
  | "charge_unavailable"
  | "minimums_unavailable";

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

export interface ItemInput {
  featureSlug: string;
  legKey: string;
  budgetCents: number;
}

export interface ValidatedItem extends ItemInput {
  role: "proactive" | "reactive";
  period: ItemPeriod;
  managed: boolean;
  minimumCents: number;
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

/** The largest budget a reactive item may carry next to this entry budget. */
export function reactiveCapCents(entryBudgetCents: number): number {
  return Math.floor(entryBudgetCents * REACTIVE_CAP_RATIO);
}

/** Judge one path's items against the published terms. Pure; throws ItemBudgetRefused. */
export function validatePathItems(
  items: ItemInput[],
  period: ItemPeriod,
  terms: SalesPathTerms
): ValidatedItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ItemBudgetRefused("invalid_items", "A sales path needs at least its entry item budget.");
  }
  const seen = new Set<string>();
  const out: ValidatedItem[] = [];
  for (const item of items) {
    const label = `${item.featureSlug} on ${item.legKey}`;
    const k = `${item.featureSlug}\u0000${item.legKey}`;
    if (seen.has(k)) {
      throw new ItemBudgetRefused("duplicate_item", `${label} is listed twice.`, 400, {
        featureSlug: item.featureSlug,
        legKey: item.legKey,
      });
    }
    seen.add(k);
    const t = terms.termsFor(item.featureSlug, item.legKey);
    if (!t) {
      throw new ItemBudgetRefused(
        "unknown_item",
        `${label} is not a channel and leg we know.`,
        400,
        { featureSlug: item.featureSlug, legKey: item.legKey }
      );
    }
    if (t.role === "customer") {
      throw new ItemBudgetRefused(
        "customer_leg_has_no_budget",
        `${label} is run by your own team, so it carries no budget.`,
        400,
        { featureSlug: item.featureSlug, legKey: item.legKey }
      );
    }
    if (t.minimumMonthlyCents === null || t.managed === null) {
      throw new ItemBudgetRefused(
        "minimums_unavailable",
        `We cannot read the minimum budget for ${label} right now, so nothing was saved. Try again in a moment.`,
        502,
        { featureSlug: item.featureSlug, legKey: item.legKey }
      );
    }
    if (!Number.isInteger(item.budgetCents) || item.budgetCents <= 0) {
      throw new ItemBudgetRefused(
        "amount_not_whole_cents",
        `The budget for ${label} must be a positive whole number of cents.`,
        400,
        { featureSlug: item.featureSlug, legKey: item.legKey }
      );
    }
    if (period === "month" && item.budgetCents % 100 !== 0) {
      throw new ItemBudgetRefused(
        "amount_not_whole_dollars",
        `A monthly budget is in whole dollars (${label}).`,
        400,
        { featureSlug: item.featureSlug, legKey: item.legKey }
      );
    }
    const minimumCents = minimumInPeriod(t.minimumMonthlyCents, period);
    if (item.budgetCents < minimumCents) {
      throw new ItemBudgetRefused(
        "below_minimum",
        `${label} needs at least ${dollars(minimumCents)}${per(period)}.`,
        400,
        { featureSlug: item.featureSlug, legKey: item.legKey, minimumCents, period }
      );
    }
    out.push({ ...item, role: t.role, period, managed: t.managed, minimumCents });
  }

  const entries = out.filter((i) => i.role === "proactive");
  if (entries.length === 0) {
    throw new ItemBudgetRefused(
      "entry_item_required",
      "A sales path needs a budget on its entry item, the channel that finds the leads."
    );
  }
  if (entries.length > 1) {
    throw new ItemBudgetRefused(
      "one_entry_item_per_path",
      "A sales path has one entry item; activate another path for another entry."
    );
  }
  const capCents = reactiveCapCents(entries[0].budgetCents);
  for (const r of out.filter((i) => i.role === "reactive")) {
    if (r.budgetCents > capCents) {
      throw new ItemBudgetRefused(
        "reactive_above_cap",
        `${r.featureSlug} on ${r.legKey} can be at most half of the entry budget: ${dollars(capCents)}${per(period)}.`,
        400,
        { featureSlug: r.featureSlug, legKey: r.legKey, capCents, period }
      );
    }
  }
  return out;
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

/**
 * Charge NOW the reactive budget this period has not collected yet. Keyed on
 * (plan, period, target total) so a retried write collapses onto one charge.
 * Returns the cents charged (0 when nothing was due).
 */
async function chargeReactiveDelta(
  plan: Subscription,
  targetReactiveCents: number
): Promise<number> {
  const collected = await reactiveCollectedInPeriod(plan);
  const delta = targetReactiveCents - collected;
  if (delta < MIN_CHARGE_CENTS) return 0;
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
    console.error(
      `[billing-service] reactive item charge for org ${plan.orgId} could not be attempted:`,
      err
    );
    throw new ItemBudgetRefused(
      "charge_unavailable",
      "The card could not be charged right now, so nothing was saved. Try again in a moment.",
      502
    );
  }
  const succeeded = outcome.status === "succeeded";
  await db.insert(salesPathReactiveCharges).values({
    orgId: plan.orgId,
    subscriptionId: plan.id,
    periodStart: plan.currentPeriodStart,
    cumulativeCents: targetReactiveCents,
    amountCents: delta,
    status: succeeded ? "paid" : "failed",
    reference: outcome.reference ?? null,
    failureCode: succeeded ? null : outcome.failure_code ?? "declined",
  });
  if (!succeeded) {
    throw new ItemBudgetRefused(
      "reactive_charge_declined",
      outcome.failure_message ?? "The card refused the charge for the reactive budgets, so nothing was saved.",
      409,
      { amountCents: delta }
    );
  }
  console.log(
    `[billing-service] reactive items: org ${plan.orgId} charged ${delta} cents now on plan ${plan.id}`
  );
  return delta;
}

/** Reactive monthly total of an offer's items on channels we run. */
function chargedReactiveMonthly(rows: Array<Pick<SalesPathItemBudget, "role" | "period" | "featureSlug" | "budgetCents">>, terms: SalesPathTerms): number {
  return rows
    .filter((r) => r.role === "reactive" && r.period === "month" && terms.managedChannel(r.featureSlug) === true)
    .reduce((sum, r) => sum + r.budgetCents, 0);
}

export interface SetPathItemsParams {
  orgId: string;
  brandId: string;
  offerId: string;
  pathKey: string;
  items: ItemInput[];
  /** The path whose entry this one takes over (removed in the same transaction). */
  replacePathKey?: string | null;
  userId: string | null;
  now?: Date;
}

export interface SetPathItemsResult {
  replacedPathKey: string | null;
  reactiveChargedCents: number;
}

/**
 * State (or restate) one path's item budgets. Refusals are ItemBudgetRefused with
 * a stable code; nothing is written on any refusal.
 */
export async function setPathItems(params: SetPathItemsParams): Promise<SetPathItemsResult> {
  const brandId = params.brandId.toLowerCase();
  const offerId = params.offerId.toLowerCase();
  const { orgId, pathKey } = params;
  const now = params.now ?? new Date();
  const period = await periodOf(orgId);
  const terms = await readTerms();
  const items = validatePathItems(params.items, period, terms);

  // One active path per entry: the entry (channel x entry leg) must be free.
  const entry = items.find((i) => i.role === "proactive")!;
  const existing = await listOfferItems(orgId, brandId, offerId);
  const holder = existing.find(
    (r) =>
      r.role === "proactive" &&
      r.featureSlug === entry.featureSlug &&
      r.legKey === entry.legKey &&
      r.pathKey !== pathKey
  );
  const replacedPathKey = holder ? holder.pathKey : null;
  if (holder && params.replacePathKey !== holder.pathKey) {
    throw new ItemBudgetRefused(
      "entry_taken",
      `Another sales path already enters with ${entry.featureSlug} on ${entry.legKey}. Replace it to activate this one.`,
      409,
      { conflictingPathKey: holder.pathKey }
    );
  }

  // The offer's items once this write lands (what the plan and the charge follow).
  const after = [
    ...existing.filter((r) => r.pathKey !== pathKey && r.pathKey !== replacedPathKey),
    ...items.map((i) => ({ ...i, pathKey })),
  ];

  let plan: Subscription | null = null;
  let reactiveChargedCents = 0;
  if (period === "month") {
    plan = await planFor(orgId, brandId, offerId);
    if (!plan) {
      throw new ItemBudgetRefused(
        "no_plan_for_offer",
        "This offer has no plan yet. Start a plan for it, then set its budgets.",
        409
      );
    }
    plan = await advanceSubscription(plan, now);
    if (plan.status === "past_due") {
      throw new ItemBudgetRefused(
        "subscription_not_active",
        "The last payment did not go through; budgets can be changed once it has.",
        409
      );
    }
    if (plan.status === "canceled") {
      throw new ItemBudgetRefused(
        "no_plan_for_offer",
        "This offer has no plan yet. Start a plan for it, then set its budgets.",
        409
      );
    }
    if (chargesReactiveNow(plan)) {
      reactiveChargedCents = await chargeReactiveDelta(plan, chargedReactiveMonthly(after, terms));
    }
  }

  await db.transaction(async (tx) => {
    for (const key of [pathKey, replacedPathKey].filter((k): k is string => !!k)) {
      await tx
        .delete(salesPathItemBudgets)
        .where(
          and(
            eq(salesPathItemBudgets.orgId, orgId),
            eq(salesPathItemBudgets.brandId, brandId),
            eq(salesPathItemBudgets.offerId, offerId),
            eq(salesPathItemBudgets.pathKey, key)
          )
        );
    }
    await tx.insert(salesPathItemBudgets).values(
      items.map((i) => ({
        orgId,
        brandId,
        offerId,
        pathKey,
        featureSlug: i.featureSlug,
        legKey: i.legKey,
        role: i.role,
        period: i.period,
        budgetCents: i.budgetCents,
        createdAt: now,
        updatedAt: now,
      }))
    );
    const changedBy = params.userId;
    if (replacedPathKey) {
      await tx.insert(salesPathItemBudgetChanges).values({
        orgId,
        brandId,
        offerId,
        pathKey: replacedPathKey,
        items: null,
        changedByUserId: changedBy,
        changedAt: now,
      });
    }
    await tx.insert(salesPathItemBudgetChanges).values({
      orgId,
      brandId,
      offerId,
      pathKey,
      items: items.map((i) => ({
        featureSlug: i.featureSlug,
        legKey: i.legKey,
        role: i.role,
        period: i.period,
        budgetCents: i.budgetCents,
      })),
      changedByUserId: changedBy,
      changedAt: now,
    });
  });

  await afterItemsChanged(orgId, brandId, plan, terms, now);
  return { replacedPathKey, reactiveChargedCents };
}

/** Remove one path's item budgets. Idempotent: false when there was nothing to remove. */
export async function removePathItems(params: {
  orgId: string;
  brandId: string;
  offerId: string;
  pathKey: string;
  userId: string | null;
  now?: Date;
}): Promise<boolean> {
  const brandId = params.brandId.toLowerCase();
  const offerId = params.offerId.toLowerCase();
  const { orgId, pathKey } = params;
  const now = params.now ?? new Date();
  const removed = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(salesPathItemBudgets)
      .where(
        and(
          eq(salesPathItemBudgets.orgId, orgId),
          eq(salesPathItemBudgets.brandId, brandId),
          eq(salesPathItemBudgets.offerId, offerId),
          eq(salesPathItemBudgets.pathKey, pathKey)
        )
      )
      .returning({ id: salesPathItemBudgets.id });
    if (rows.length === 0) return false;
    await tx.insert(salesPathItemBudgetChanges).values({
      orgId,
      brandId,
      offerId,
      pathKey,
      items: null,
      changedByUserId: params.userId,
      changedAt: now,
    });
    return true;
  });
  if (!removed) return false;
  let terms: SalesPathTerms | null = null;
  try {
    terms = await getSalesPathTerms();
  } catch (err) {
    console.error("[billing-service] sales-path terms unreadable after a path removal:", err);
  }
  const plan = (await getPaymentMode(orgId)) === "subscription" ? await planFor(orgId, brandId, offerId) : null;
  await afterItemsChanged(orgId, brandId, plan, terms, now);
  return true;
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
  const rows = await listBrandItems(orgId, brandId);
  if (rows.length > 0) {
    await db.insert(brandDailyBudgetChanges).values({
      orgId,
      brandId,
      dailyBudgetCents: itemsDailyTotalCents(rows, terms),
      changedAt: now,
    });
  }
}

// --- reads -----------------------------------------------------------------

export interface ItemView {
  featureSlug: string;
  legKey: string;
  role: "proactive" | "reactive";
  period: ItemPeriod;
  budgetCents: number;
  /** false = a channel we do not run yet: recorded, charged nothing. */
  managed: boolean | null;
  /** The minimum in this item's period. */
  minimumCents: number | null;
  /** For a reactive item: the most it may carry (half the path's entry item). */
  capCents: number | null;
}

export interface PathView {
  pathKey: string;
  items: ItemView[];
  updatedAt: string;
}

export interface OfferItemsView {
  brandId: string;
  offerId: string;
  /** The period the org states budgets in now (subscription → month). */
  period: ItemPeriod;
  paths: PathView[];
  /** For a subscriber: what the offer's plan costs from its items; null otherwise. */
  plan: (ItemsPlanPricing & { subscriptionId: string; currentMonthlyAmountCents: number }) | null;
  /** For a subscriber with no plan priced from items yet: the items' pricing alone. */
  pricing: ItemsPlanPricing | null;
}

export async function getOfferItemsView(
  orgId: string,
  brandId: string,
  offerId: string
): Promise<OfferItemsView> {
  brandId = brandId.toLowerCase();
  offerId = offerId.toLowerCase();
  const period = await periodOf(orgId);
  const rows = await listOfferItems(orgId, brandId, offerId);
  const terms = await readTerms();
  const byPath = new Map<string, SalesPathItemBudget[]>();
  for (const r of rows) {
    const list = byPath.get(r.pathKey) ?? [];
    list.push(r);
    byPath.set(r.pathKey, list);
  }
  const paths: PathView[] = [...byPath.entries()].map(([pathKey, list]) => {
    const entry = list.find((r) => r.role === "proactive");
    return {
      pathKey,
      updatedAt: list
        .reduce((latest, r) => (r.updatedAt > latest ? r.updatedAt : latest), list[0].updatedAt)
        .toISOString(),
      items: list.map((r) => {
        const t = terms.termsFor(r.featureSlug, r.legKey);
        const p = r.period as ItemPeriod;
        return {
          featureSlug: r.featureSlug,
          legKey: r.legKey,
          role: r.role as "proactive" | "reactive",
          period: p,
          budgetCents: r.budgetCents,
          managed: t?.managed ?? null,
          minimumCents: t?.minimumMonthlyCents == null ? null : minimumInPeriod(t.minimumMonthlyCents, p),
          capCents: r.role === "reactive" && entry ? reactiveCapCents(entry.budgetCents) : null,
        };
      }),
    };
  });
  let plan: OfferItemsView["plan"] = null;
  const pricing = period === "month" ? itemsPlanPricing(rows, terms) : null;
  if (period === "month") {
    const live = (await listLiveSubscriptions(orgId)).find(
      (s) => s.brandId === brandId && s.offerId === offerId
    );
    if (live && pricing) {
      plan = { ...pricing, subscriptionId: live.id, currentMonthlyAmountCents: live.monthlyAmountCents };
    }
  }
  return { brandId, offerId, period, paths, plan, pricing };
}

/** One item as campaign-service spends it (GET /internal/brands/:id/sales-budget, mode "items"). */
export interface SpendItemView {
  offerId: string;
  legKey: string;
  featureSlug: string;
  role: "proactive" | "reactive";
  /** Decimal cents. A reactive monthly item includes the carry-over from last period. */
  budgetCents: string;
  period: ItemPeriod;
  /** The plan's current period for a monthly item; null for a daily one. */
  periodStart: string | null;
  periodEnd: string | null;
  /** false = a channel we do not run yet (never charged); null = catalogue unreadable. */
  managed: boolean | null;
  /** The combinationKeys of the paths funding this item. */
  pathKeys: string[];
}

export interface BrandItemsSpendView {
  items: SpendItemView[];
  /** Daily equivalent of the proactive items we run (day + month/30). */
  dailyBudgetCents: string;
  updatedAt: Date;
}

/** The brand's items as campaign-service spends them; null when the brand holds none. */
export async function getBrandItemsSpendView(
  orgId: string,
  brandId: string
): Promise<BrandItemsSpendView | null> {
  brandId = brandId.toLowerCase();
  const rows = await listBrandItems(orgId, brandId);
  if (rows.length === 0) return null;
  let terms: SalesPathTerms | null = null;
  try {
    terms = await getSalesPathTerms();
  } catch (err) {
    console.error(
      `[billing-service] sales-path terms unreadable for brand ${brandId}: items served with managed=null`,
      err
    );
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
  // A monthly item funds a campaign only through a live plan's current period;
  // with no plan (ended, or never started) it funds nothing and is not served
  // (campaign-service holds the whole brand on an incomplete monthly item).
  const spendable = spendableItemsOf(rows).filter(
    (i) => i.period === "day" || plans.some((p) => p.offerId === i.offerId)
  );
  const items: SpendItemView[] = spendable.map((i) => {
    const plan = i.period === "month" ? plans.find((p) => p.offerId === i.offerId) ?? null : null;
    let budget = i.budgetCents;
    if (i.role === "reactive" && i.period === "month") {
      const carry = carryByOffer.get(i.offerId) ?? 0;
      const reactiveTotal = spendable
        .filter((x) => x.offerId === i.offerId && x.role === "reactive" && x.period === "month")
        .reduce((sum, x) => sum + x.budgetCents, 0);
      if (carry > 0 && reactiveTotal > 0) budget += (carry * i.budgetCents) / reactiveTotal;
    }
    return {
      offerId: i.offerId,
      legKey: i.legKey,
      featureSlug: i.featureSlug,
      role: i.role,
      budgetCents: budget.toFixed(10),
      period: i.period,
      periodStart: plan ? plan.currentPeriodStart.toISOString() : null,
      periodEnd: plan ? plan.currentPeriodEnd.toISOString() : null,
      managed: terms ? terms.managedChannel(i.featureSlug) : null,
      pathKeys: i.pathKeys,
    };
  });
  return {
    items,
    dailyBudgetCents: itemsDailyTotalCents(rows, terms),
    updatedAt: rows.reduce((latest, r) => (r.updatedAt > latest ? r.updatedAt : latest), rows[0].updatedAt),
  };
}
