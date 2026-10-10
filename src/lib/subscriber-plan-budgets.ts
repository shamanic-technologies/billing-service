/**
 * A SUBSCRIBER's campaign budgets come from its PLAN (owner 2026-10-05, migration 0065).
 *
 * A subscriber whose campaigns still carry a legacy DAILY ceiling (written before
 * monthly budgets existed, e.g. a $50/day launch default) used to read it x30 as its
 * monthly budget: "$1,500/month (from your $50/day)" on a client paying a $99 plan.
 * That figure was never chosen and never paid. For a subscriber the plan is the
 * budget, so each such offer is restated, once, from its live plan:
 *
 *  - ON follow-up campaigns (reactive, a channel we run) carry their MAX: the plan's
 *    follow-up share (PLAN_FOLLOW_UP_SHARE, 9%, rounded UP to the dollar: $99 → $9).
 *  - ON entry campaigns (proactive, a channel we run, campaign `ongoing`) share what
 *    is left of the plan, in whole dollars ($99 − $9 = $90). The figures shown add up
 *    to the plan: the customer reads how its $99 is shared.
 *  - Every other legacy row (OFF campaign, a channel we do not run, a customer-team
 *    or unknown leg) is DELETED: "not set". An OFF campaign claims no plan money;
 *    the customer states a budget when turning it back on.
 *
 * Restated rows are monthly (daily ceiling = monthly / 30, so campaign-service paces
 * on the new figure) and stamped `plan_derived`: they never re-price the plan and are
 * never charged on top of it. NOTHING is charged, refunded or re-priced by this.
 *
 * An offer is left alone (logged) when it has no live plan, already holds a monthly
 * budget (the customer stated some), has no ON entry campaign, or its catalogue /
 * campaign status is unreadable; the next tick retries. prepaid / postpaid orgs are
 * never read. Runs on the hourly scheduler tick (first tick a minute after boot).
 */

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { withRecurringFunnelCaps } from "./funnel-campaigns.js";
import { db } from "../db/index.js";
import { billingAccounts, brandDailyBudgetChanges, campaignDailyBudgets, type CeilingRow } from "../db/schema.js";
import { DAYS_PER_MONTH, getSalesPathTerms, type SalesPathTerms } from "./sales-path-terms.js";
import { campaignOnPredicateOf, type CampaignOnPredicate } from "./campaign-items-store.js";
import { fetchRecurringCampaignStatuses } from "./campaign-service-client.js";
import { onCampaignStatusChanged } from "./campaign-items.js";
import { getPaymentMode } from "./payment-mode.js";
import { sumCeilings } from "./campaign-budgets.js";
import { getBrandSalesBudget } from "./brand-sales-budget.js";
import { listLiveSubscriptions } from "./subscription.js";
import { attributeUnassignedPlan } from "./subscription-plans.js";
import { scaledSourcingCeilingSql } from "./campaign-sourcing.js";
import { canonicalLegKey, legIdentityKey } from "./leg-identity.js";

export interface PlanBudgetRow {
  featureSlug: string;
  legKey: string;
  /** The restated monthly budget; null = the row is deleted ("not set"). */
  monthlyBudgetCents: number | null;
}

/**
 * The restatement of one offer's legacy rows from its plan. Pure. Null when the offer
 * has no ON entry campaign on a channel we run (nothing can carry the plan).
 */
export function planBudgetsFor(
  rows: Array<{ brandId: string; offerId: string; featureSlug: string; legKey: string }>,
  planMonthlyCents: number,
  terms: SalesPathTerms,
  isOn: CampaignOnPredicate
): PlanBudgetRow[] | null {
  const campaigns = rows.map((r) => ({ featureSlug: r.featureSlug, legKey: r.legKey, on: isOn(r) }));
  if (!campaigns.some((c) => c.on && runRoleOf(c, terms) === "proactive")) return null;
  return planAllocationFor(campaigns, planMonthlyCents, terms);
}

export interface PlanBudgetsSweepResult {
  /** (org, brand, offer) groups holding legacy daily rows. */
  offers: number;
  /** Groups restated from their plan. */
  restatedOffers: number;
  /** Distinct orgs with at least one group restated. */
  restatedOrgs: number;
  rowsRestated: number;
  rowsDeleted: number;
  skipped: number;
}

/** Restate every subscriber's legacy daily campaign ceilings from its live plan. */
export async function restateSubscriberBudgetsFromPlans(now = new Date()): Promise<PlanBudgetsSweepResult> {
  const result: PlanBudgetsSweepResult = {
    offers: 0,
    restatedOffers: 0,
    restatedOrgs: 0,
    rowsRestated: 0,
    rowsDeleted: 0,
    skipped: 0,
  };
  const groups = await db
    .selectDistinct({
      orgId: campaignDailyBudgets.orgId,
      brandId: campaignDailyBudgets.brandId,
      offerId: campaignDailyBudgets.offerId,
    })
    .from(campaignDailyBudgets)
    .innerJoin(billingAccounts, eq(billingAccounts.orgId, campaignDailyBudgets.orgId))
    .where(
      and(
        eq(billingAccounts.paymentMode, "subscription"),
        isNull(campaignDailyBudgets.monthlyBudgetCents),
        isNotNull(campaignDailyBudgets.offerId),
        isNotNull(campaignDailyBudgets.legKey)
      )
    );
  if (groups.length === 0) return result;
  result.offers = groups.length;

  let terms: SalesPathTerms;
  try {
    terms = await getSalesPathTerms();
  } catch (err) {
    console.error("[billing-service] plan budgets: catalogue unreadable, retrying next tick", err);
    result.skipped = groups.length;
    return result;
  }

  const orgs = new Set<string>();
  for (const g of groups) {
    const offerId = g.offerId as string;
    const where = `org ${g.orgId} brand ${g.brandId} offer ${offerId}`;
    try {
      try {
        await attributeUnassignedPlan(g.orgId);
      } catch (err) {
        console.error(`[billing-service] plan budgets: could not attribute the onboarding plan of org ${g.orgId}`, err);
      }
      const plan = (await listLiveSubscriptions(g.orgId)).find((s) => s.brandId === g.brandId && s.offerId === offerId);
      if (!plan) {
        console.warn(`[billing-service] plan budgets: ${where} has legacy daily ceilings but no live plan; left as is`);
        result.skipped++;
        continue;
      }
      const statuses = await fetchRecurringCampaignStatuses(g.orgId);
      if (!statuses.ok) {
        console.error(`[billing-service] plan budgets: ${where}: campaign status unreadable (${statuses.reason}), retrying next tick`);
        result.skipped++;
        continue;
      }
      const isOn = campaignOnPredicateOf(statuses.campaigns);

      const outcome = await db.transaction(async (tx) => {
        const rows: CeilingRow[] = await tx
          .select()
          .from(campaignDailyBudgets)
          .where(and(eq(campaignDailyBudgets.orgId, g.orgId), eq(campaignDailyBudgets.brandId, g.brandId)))
          .for("update");
        // A SOURCE campaign's budget (a sourcing origin) is the customer's, never restated from the plan.
        const offerRows = rows.filter(
          (r) => r.offerId === offerId && r.legKey !== null && !terms.isSourceItem(r.featureSlug, r.legKey)
        );
        if (offerRows.some((r) => r.monthlyBudgetCents !== null)) return "mixed" as const;
        const legacy = offerRows.filter((r) => r.monthlyBudgetCents === null);
        if (legacy.length === 0) return "done" as const;
        const restatement = planBudgetsFor(
          legacy.map((r) => ({ brandId: r.brandId, offerId, featureSlug: r.featureSlug, legKey: r.legKey as string })),
          plan.monthlyAmountCents,
          terms,
          isOn
        );
        if (!restatement) return "no_entry" as const;

        let restated = 0;
        let deleted = 0;
        for (const p of restatement) {
          const before = legacy.find((r) => r.featureSlug === p.featureSlug && r.legKey === p.legKey)!;
          const key = and(
            eq(campaignDailyBudgets.orgId, g.orgId),
            eq(campaignDailyBudgets.brandId, g.brandId),
            eq(campaignDailyBudgets.offerId, offerId),
            eq(campaignDailyBudgets.featureSlug, p.featureSlug),
            eq(campaignDailyBudgets.legKey, p.legKey),
            isNull(campaignDailyBudgets.monthlyBudgetCents)
          );
          if (p.monthlyBudgetCents === null) {
            await tx.delete(campaignDailyBudgets).where(key);
            deleted++;
          } else {
            await tx
              .update(campaignDailyBudgets)
              .set({
                monthlyBudgetCents: p.monthlyBudgetCents,
                dailyBudgetCents: (p.monthlyBudgetCents / DAYS_PER_MONTH).toFixed(10),
                sourcingCeilingCents: scaledSourcingCeilingSql((p.monthlyBudgetCents / DAYS_PER_MONTH).toFixed(10)),
                planDerived: true,
                updatedAt: now,
              })
              .where(key);
            restated++;
          }
          console.log(
            `[billing-service] plan budgets: ${where} ${p.featureSlug}:${p.legKey} ` +
              `daily ${before.dailyBudgetCents} -> ${p.monthlyBudgetCents === null ? "not set (deleted)" : `${p.monthlyBudgetCents}/month from plan ${plan.id} (${plan.monthlyAmountCents}/month)`}`
          );
        }
        // The brand-total timeline (the by-day replay) follows, unless the brand is on a global pot.
        if (!(await getBrandSalesBudget(g.orgId, g.brandId))) {
          const left = await tx
            .select()
            .from(campaignDailyBudgets)
            .where(and(eq(campaignDailyBudgets.orgId, g.orgId), eq(campaignDailyBudgets.brandId, g.brandId)));
          await tx.insert(brandDailyBudgetChanges).values({
            orgId: g.orgId,
            brandId: g.brandId,
            dailyBudgetCents: await withRecurringFunnelCaps(tx, g.orgId, g.brandId, sumCeilings(left)),
            changedAt: now,
          });
        }
        return { restated, deleted };
      });

      if (outcome === "done") continue;
      if (outcome === "mixed" || outcome === "no_entry") {
        console.warn(
          `[billing-service] plan budgets: ${where} left as is (${outcome === "mixed" ? "the customer already stated monthly budgets" : "no ON entry campaign on a channel we run"})`
        );
        result.skipped++;
        continue;
      }
      result.restatedOffers++;
      result.rowsRestated += outcome.restated;
      result.rowsDeleted += outcome.deleted;
      orgs.add(g.orgId);
    } catch (err) {
      console.error(`[billing-service] plan budgets: ${where} failed, retrying next tick`, err);
      result.skipped++;
    }
  }
  result.restatedOrgs = orgs.size;
  return result;
}

// --- The plan FOLLOWS the ON campaigns (owner 2026-10-05) --------------------
//
// The customer no longer types a budget on the offer's Campaigns table: for a
// subscriber the money IS the plan. campaign-service keeps ONE proactive campaign
// ON per offer; when a person switches which one (stops the old, starts the new,
// and notifies us through mission-status-changed), the plan money MOVES with it:
//
//  - each ON reactive campaign on a channel we run carries a MAX of the plan's
//    follow-up share (9%, rounded UP to the dollar: $99 -> $9; owner 2026-10-05);
//  - the ON proactive campaign(s) on a channel we run carry the REST of the plan
//    ($99 - $9 = $90; several ON, a legacy state, share it in whole dollars,
//    leftover dollars to the first), so the figures add up to the plan;
//  - every other campaign of the offer is "not set" (row deleted): OFF claims nothing.
//
// Every row written is `plan_derived`: it never prices the plan and is never
// charged on top of it, so a switch NEVER changes what the customer pays.

export interface OfferCampaign {
  featureSlug: string;
  legKey: string;
  on: boolean;
}

/**
 * The share of a subscriber's plan an ON follow-up (reactive) campaign carries as its
 * MAX (owner 2026-10-05: $9 of a $99 plan, the lead-finding campaign $90).
 */
export const PLAN_FOLLOW_UP_SHARE = 0.09;

/** One follow-up's MAX from the plan, in whole dollars rounded UP ($99 -> $9). */
export function planFollowUpCents(planMonthlyCents: number): number {
  return Math.ceil(Math.floor(planMonthlyCents / 100) * PLAN_FOLLOW_UP_SHARE) * 100;
}

function runRoleOf(c: { featureSlug: string; legKey: string }, terms: SalesPathTerms): "proactive" | "reactive" | null {
  const t = terms.termsFor(c.featureSlug, c.legKey);
  return t && t.role !== "customer" && t.managed === true && terms.managedChannel(c.featureSlug) === true
    ? t.role
    : null;
}

/** Pure: where one offer's plan money sits, given which of its campaigns are ON. */
export function planAllocationFor(
  campaigns: OfferCampaign[],
  planMonthlyCents: number,
  terms: SalesPathTerms
): PlanBudgetRow[] {
  const sorted = [...campaigns].sort((a, b) =>
    a.featureSlug === b.featureSlug ? a.legKey.localeCompare(b.legKey) : a.featureSlug.localeCompare(b.featureSlug)
  );
  const planDollars = Math.floor(planMonthlyCents / 100);
  const followUps = sorted.filter((c) => c.on && runRoleOf(c, terms) === "reactive");
  const followUpCents = planFollowUpCents(planMonthlyCents);
  const entries = sorted.filter((c) => c.on && runRoleOf(c, terms) === "proactive");
  // Entries carry what the follow-ups leave of the plan (never below zero).
  const entryDollars = Math.max(0, planDollars - (followUps.length * followUpCents) / 100);
  const base = entries.length > 0 ? Math.floor(entryDollars / entries.length) : 0;
  const extra = entryDollars - base * entries.length;
  const entryCents = new Map<string, number>();
  entries.forEach((c, i) => entryCents.set(`${c.featureSlug}\u0000${c.legKey}`, (base + (i < extra ? 1 : 0)) * 100));

  return sorted.map((c) => {
    let monthly: number | null = entryCents.get(`${c.featureSlug}\u0000${c.legKey}`) ?? null;
    if (monthly === null && c.on && runRoleOf(c, terms) === "reactive") monthly = followUpCents;
    if (monthly !== null && monthly <= 0) monthly = null;
    return { featureSlug: c.featureSlug, legKey: c.legKey, monthlyBudgetCents: monthly };
  });
}

export type PlanFollowOutcome =
  | { status: "allocated"; written: number; deleted: number; unchanged: number }
  | { status: "skipped"; reason: "no_offer" | "not_subscriber" | "no_plan" | "campaign_status_unavailable" };

/**
 * Move a subscriber's plan money onto the offer's ON campaigns (read LIVE from
 * campaign-service, under a per-offer lock so a stop and a start racing each
 * other converge on the latest status). prepaid / postpaid orgs are never touched.
 */
export async function allocatePlanToOnCampaigns(params: {
  orgId: string;
  brandId: string;
  offerId: string | null;
  now?: Date;
}): Promise<PlanFollowOutcome> {
  const { orgId } = params;
  const brandId = params.brandId.toLowerCase();
  const offerId = params.offerId?.toLowerCase() ?? null;
  const now = params.now ?? new Date();
  if (!offerId) return { status: "skipped", reason: "no_offer" };
  if ((await getPaymentMode(orgId)) !== "subscription") return { status: "skipped", reason: "not_subscriber" };
  const where = `org ${orgId} brand ${brandId} offer ${offerId}`;

  try {
    await attributeUnassignedPlan(orgId);
  } catch (err) {
    console.error(`[billing-service] plan follows campaigns: could not attribute the onboarding plan of org ${orgId}`, err);
  }
  const plan = (await listLiveSubscriptions(orgId)).find((s) => s.brandId === brandId && s.offerId === offerId);
  if (!plan) {
    console.warn(`[billing-service] plan follows campaigns: ${where} has no live plan; budgets left as is`);
    return { status: "skipped", reason: "no_plan" };
  }
  const terms = await getSalesPathTerms();

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`plan-follows:${orgId}:${brandId}:${offerId}`}))`);
    const statuses = await fetchRecurringCampaignStatuses(orgId);
    if (!statuses.ok) {
      console.error(`[billing-service] plan follows campaigns: ${where}: campaign status unreadable (${statuses.reason}); budgets left as is`);
      return { status: "skipped", reason: "campaign_status_unavailable" } as const;
    }
    const rows: CeilingRow[] = await tx
      .select()
      .from(campaignDailyBudgets)
      .where(and(eq(campaignDailyBudgets.orgId, orgId), eq(campaignDailyBudgets.brandId, brandId)))
      .for("update");
    const offerRows = rows.filter((r) => r.offerId === offerId && r.legKey !== null);

    const campaigns = new Map<string, OfferCampaign>();
    // Either spelling of an outbound leg is one campaign; the stored row keeps its spelling.
    const keyOf = (featureSlug: string, legKey: string) => legIdentityKey(featureSlug, legKey).toLowerCase();
    for (const r of offerRows) campaigns.set(keyOf(r.featureSlug, r.legKey as string), { featureSlug: r.featureSlug, legKey: r.legKey as string, on: false });
    for (const c of statuses.campaigns) {
      if (c.brandId?.toLowerCase() !== brandId || c.offerId?.toLowerCase() !== offerId || !c.featureSlug || !c.legKey) continue;
      const k = keyOf(c.featureSlug, c.legKey);
      const known = campaigns.get(k) ?? { featureSlug: c.featureSlug, legKey: c.legKey, on: false };
      campaigns.set(k, { ...known, on: known.on || c.status === "ongoing" });
    }

    let written = 0;
    let deleted = 0;
    let unchanged = 0;
    // A SOURCE campaign (a sourcing origin, owner 2026-10-07) is not plan money: the
    // plan is never split onto it and its row is never written nor deleted here.
    const planCampaigns = [...campaigns.values()].filter((c) => !terms.isSourceItem(c.featureSlug, c.legKey));
    for (const p of planAllocationFor(planCampaigns, plan.monthlyAmountCents, terms)) {
      const before = offerRows.find((r) => keyOf(r.featureSlug, r.legKey as string) === keyOf(p.featureSlug, p.legKey));
      const key = and(
        eq(campaignDailyBudgets.orgId, orgId),
        eq(campaignDailyBudgets.brandId, brandId),
        eq(campaignDailyBudgets.offerId, offerId),
        eq(campaignDailyBudgets.featureSlug, before?.featureSlug ?? p.featureSlug),
        eq(campaignDailyBudgets.legKey, before?.legKey ?? p.legKey)
      );
      const was = before ? (before.monthlyBudgetCents !== null ? `${before.monthlyBudgetCents}/month` : `${before.dailyBudgetCents}/day`) : "not set";
      if (p.monthlyBudgetCents === null) {
        if (!before) continue;
        await tx.delete(campaignDailyBudgets).where(key);
        deleted++;
      } else if (before && before.monthlyBudgetCents === p.monthlyBudgetCents && before.planDerived === true) {
        unchanged++;
        continue;
      } else {
        const values = {
          monthlyBudgetCents: p.monthlyBudgetCents,
          dailyBudgetCents: (p.monthlyBudgetCents / DAYS_PER_MONTH).toFixed(10),
          planDerived: true,
          updatedAt: now,
        };
        if (before)
          await tx
            .update(campaignDailyBudgets)
            .set({ ...values, sourcingCeilingCents: scaledSourcingCeilingSql(values.dailyBudgetCents) })
            .where(key);
        else
          await tx.insert(campaignDailyBudgets).values({
            orgId,
            brandId,
            offerId,
            featureSlug: p.featureSlug,
            legKey: canonicalLegKey(p.featureSlug, p.legKey),
            ...values,
          });
        written++;
      }
      console.log(
        `[billing-service] plan follows campaigns: ${where} ${p.featureSlug}:${p.legKey} ${was} -> ` +
          (p.monthlyBudgetCents === null ? "not set" : `${p.monthlyBudgetCents}/month from plan ${plan.id} (${plan.monthlyAmountCents}/month)`)
      );
    }

    if ((written > 0 || deleted > 0) && !(await getBrandSalesBudget(orgId, brandId))) {
      const left = await tx
        .select()
        .from(campaignDailyBudgets)
        .where(and(eq(campaignDailyBudgets.orgId, orgId), eq(campaignDailyBudgets.brandId, brandId)));
      await tx.insert(brandDailyBudgetChanges).values({
        orgId,
        brandId,
        dailyBudgetCents: await withRecurringFunnelCaps(tx, orgId, brandId, sumCeilings(left)),
        changedAt: now,
      });
    }
    return { status: "allocated", written, deleted, unchanged } as const;
  });
}

/**
 * mission-status-changed: first move a subscriber's plan money onto the ON
 * campaigns, then the usual re-price (a no-op on derived rows). Never throws.
 */
export async function onMissionStatusChanged(params: { orgId: string; brandId: string; offerId: string | null; now?: Date }): Promise<void> {
  try {
    await allocatePlanToOnCampaigns(params);
  } catch (err) {
    console.error(
      `[billing-service] plan follows campaigns: org ${params.orgId} brand ${params.brandId} offer ${params.offerId} failed (budgets left as is):`,
      err
    );
  }
  await onCampaignStatusChanged(params);
}

export interface DerivedPlansSweepResult {
  /** Live plans (brand x offer) whose budget rows are all plan-derived. */
  offers: number;
  /** Of those, offers where a row moved (the allocation rule or the ON set changed). */
  reallocatedOffers: number;
  skipped: number;
}

/**
 * Keep every plan-derived offer on the CURRENT allocation rule (hourly tick). An offer
 * whose budget rows are ALL plan-derived is re-allocated from its plan and the live
 * ON campaigns; an offer holding any customer-stated row is left alone (only a
 * person's on/off switch re-allocates it). Idempotent: an offer already on the rule
 * writes nothing. Never charges, never re-prices.
 */
export async function reallocateDerivedPlans(now = new Date()): Promise<DerivedPlansSweepResult> {
  const result: DerivedPlansSweepResult = { offers: 0, reallocatedOffers: 0, skipped: 0 };
  const orgs = await db
    .select({ orgId: billingAccounts.orgId })
    .from(billingAccounts)
    .where(eq(billingAccounts.paymentMode, "subscription"));
  for (const { orgId } of orgs) {
    let plans;
    try {
      plans = await listLiveSubscriptions(orgId);
    } catch (err) {
      console.error(`[billing-service] derived plans: org ${orgId} plans unreadable, retrying next tick`, err);
      result.skipped++;
      continue;
    }
    for (const plan of plans) {
      if (!plan.brandId || !plan.offerId) continue;
      const rows = (
        await db
          .select()
          .from(campaignDailyBudgets)
          .where(and(eq(campaignDailyBudgets.orgId, orgId), eq(campaignDailyBudgets.brandId, plan.brandId)))
      ).filter((r) => r.offerId === plan.offerId && r.legKey !== null);
      if (rows.length === 0 || !rows.every((r) => r.planDerived === true)) continue;
      result.offers++;
      try {
        const outcome = await allocatePlanToOnCampaigns({ orgId, brandId: plan.brandId, offerId: plan.offerId, now });
        if (outcome.status === "skipped") result.skipped++;
        else if (outcome.written > 0 || outcome.deleted > 0) result.reallocatedOffers++;
      } catch (err) {
        console.error(
          `[billing-service] derived plans: org ${orgId} brand ${plan.brandId} offer ${plan.offerId} failed, retrying next tick`,
          err
        );
        result.skipped++;
      }
    }
  }
  return result;
}
