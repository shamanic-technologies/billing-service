/**
 * The SOLO-FOUNDER plan (owner 2026-11-25, SOLO-PLAN-1125). Reached only through the
 * new MCP tools; every account that exists keeps its own offer (an org is on this
 * plan only once a caller ENROLS it).
 *
 * The owner's model, worked through:
 *
 *   FREE    the founder brings their own keys. Conversation with Distry and the
 *           signup analysis run on OUR keys up to a DEBT of $2 (« ce n'est pas du
 *           crédit donné, c'est une dette de crédit qu'on accepte jusqu'à -$2 »).
 *           No campaign spends on our keys (the paid plan is needed, $2 or not).
 *   TRIAL   card required, a prepaid card refused, a $99 authorization HOLD taken at
 *           once, 3 days, spend capped at $10 (« CB + plafond de $10 pendant les 3
 *           jours … Prendre l'empreinte bancaire de $99 tout de suite »).
 *   PAID    $99/month = $99 of credit on our keys. The trial end captures the hold.
 *           Debt is repaid by arithmetic: owes $2, pays $99, starts with $97
 *           (credited − usage, nothing special-cased).
 *   LAYER   +$100/month, charged at once: new amount MINUS the credit left unspent in
 *           the current cycle, and the cycle restarts today. Dec 1 pays $99; Dec 12
 *           has spent $40 ($59 left), upgrades to $199 -> pays $199 − $59 = $140,
 *           holds $199 until Jan 11, next charge $199 on Jan 12. The discount is
 *           UNSPENT CREDIT, never unused time.
 *   CYCLE   credit left at a cycle end without upgrade is lost: expired through
 *           `subscription_credit_expiries` (subscription_id = this plan's id), so
 *           every balance path subtracts it like spend (lib/transfer-usage).
 *   OUT     out of credit -> campaigns stop (authorize + affordability refuse) and
 *           the plan read says so, with the next step to offer.
 *
 * Money moves only through the existing paths: stripe-service card holds (capture at
 * trial end) and the acquirer-neutral off-session charge (`reloadOffSession`). A
 * payment is counted once, by stripe-service's totals; nothing here grants credit.
 */
import { and, eq, isNull, lt, or, sql as rawSql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import {
  AGENT_API_FREE_CREDIT_OFFER,
  AT_COST_FREE_CREDIT_OFFER,
  billingAccounts,
  localPromoCodes,
  localPromos,
  ORG_CREATION_BONUS_CODE,
  PLATFORM_USER_ID,
  SOLO_FOUNDER_OFFER,
  soloPlanCharges,
  soloPlans,
  subscriptionCreditExpiries,
  type SoloPlan,
  type SoloPlanCharge,
} from "../db/schema.js";
import { computeBalance } from "./balance.js";
import { ensureOrgStripeCustomer } from "./account.js";
import { nextPeriodEnd } from "./subscription-schedule.js";
import { confirmChargeableCard, getLiveSubscription, savedCardIsPrepaid } from "./subscription.js";
import {
  captureCardHold,
  getCardSetup,
  getSavedPaymentMethod,
  sumSucceededTopupsForOrg,
  type CardHold,
  type IdentityHeaders,
} from "./stripe-service-client.js";
import { placeHoldRetryingPending, refusedHoldMessage } from "./postpaid-card-check.js";
import { reloadOffSession } from "./reload.js";
import { recordChargeSignal } from "./payment-alerts.js";
import { nextRetryDueAt } from "./campaign-reload-sweep.js";
import { isPermanentDecline } from "./card-usability.js";
import { notifyOwnerBillingEvent } from "./owner-alerts.js";

export const SOLO_PLAN_BASE_MONTHLY_CENTS = 9900;
export const SOLO_PLAN_LAYER_CENTS = 10000;
export const SOLO_PLAN_TRIAL_DAYS = 3;
/** Spend allowed during the trial (« plafond de $10 »). */
export const SOLO_PLAN_TRIAL_SPEND_CAP_CENTS = 1000;
/** The debt we accept on our keys while the founder is on their own keys. */
export const SOLO_PLAN_DEBT_LIMIT_CENTS = 200;
/** Marks the hold THIS module places; no other path captures it. */
export const SOLO_PLAN_TRIAL_HOLD_PURPOSE = "solo_plan_trial";
/** A card page handed out stays "start when the card lands" this long. */
const START_REQUEST_TTL_MS = 48 * 60 * 60 * 1000;
const PENDING_CHANGE_TTL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHARGE_TIMEOUT_MS = 30_000;
/** The acquirer rejects smaller charges (STRIPE_MIN_CHARGE_CENTS elsewhere). */
const MIN_CHARGE_CENTS = 50;
const MAX_BOUNDARIES_PER_SETTLE = 3;

export type SoloPlanStatus = "free" | "trialing" | "active" | "past_due";

export type SoloPlanRefusalCode =
  | "offer_not_switchable"
  | "existing_paying_org"
  | "subscription_exists"
  | "not_enrolled"
  | "plan_exists"
  | "prepaid_card_refused"
  | "card_hold_refused"
  | "card_hold_requires_action"
  | "first_charge_declined"
  | "charge_unavailable"
  | "not_trialing"
  | "not_active"
  | "change_in_progress"
  | "layer_charge_declined";

const REFUSAL_STATUS: Record<SoloPlanRefusalCode, number> = {
  offer_not_switchable: 409,
  existing_paying_org: 409,
  subscription_exists: 409,
  not_enrolled: 404,
  plan_exists: 409,
  prepaid_card_refused: 409,
  card_hold_refused: 409,
  card_hold_requires_action: 409,
  first_charge_declined: 409,
  charge_unavailable: 502,
  not_trialing: 409,
  not_active: 409,
  change_in_progress: 409,
  layer_charge_declined: 409,
};

export class SoloPlanRefused extends Error {
  readonly status: number;
  constructor(
    readonly code: SoloPlanRefusalCode,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.status = REFUSAL_STATUS[code];
  }
}

/** Customer-facing refusal for a card that cannot carry a subscription. */
export const SOLO_PREPAID_CARD_MESSAGE =
  "Prepaid cards can't carry the monthly plan. Use a debit or credit card.";

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`solo plan charge timeout after ${ms}ms`)), ms);
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

function upstreamStatus(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/stripe-service .* failed: (\d{3})/);
  return m ? Number(m[1]) : null;
}

// --- reads -----------------------------------------------------------------

export async function getSoloPlan(orgId: string): Promise<SoloPlan | null> {
  const [row] = await db.select().from(soloPlans).where(eq(soloPlans.orgId, orgId)).limit(1);
  return row ?? null;
}

/** The plan of an org on the solo-founder offer, or null (every other org). */
export async function getSoloPlanOfOrg(orgId: string, offer: string | null | undefined): Promise<SoloPlan | null> {
  if (offer !== SOLO_FOUNDER_OFFER) return null;
  const plan = await getSoloPlan(orgId);
  if (!plan) throw new Error(`org ${orgId} carries the solo_founder offer but has no solo plan row`);
  return plan;
}

export interface SoloSpendVerdict {
  allowed: boolean;
  /** The spendable balance this spend may not take the org below. */
  floorCents: string;
  /** Why it was refused; null when allowed. */
  reason: "paid_plan_required" | "debt_limit_reached" | "trial_cap_reached" | "credit_used_up" | "payment_failed" | null;
}

/** The floor of the plan's state (pure). */
export function soloFloorCents(plan: SoloPlan): string {
  switch (plan.status as SoloPlanStatus) {
    case "free":
      return new Decimal(-SOLO_PLAN_DEBT_LIMIT_CENTS).toFixed(10);
    case "trialing":
      if (plan.trialFloorCents === null) throw new Error(`solo plan ${plan.id} is trialing with no trial floor`);
      return new Decimal(plan.trialFloorCents).toFixed(10);
    default:
      return "0.0000000000";
  }
}

function outReason(plan: SoloPlan): Exclude<SoloSpendVerdict["reason"], "paid_plan_required" | null> {
  switch (plan.status as SoloPlanStatus) {
    case "free":
      return "debt_limit_reached";
    case "trialing":
      return "trial_cap_reached";
    case "past_due":
      return "payment_failed";
    default:
      return "credit_used_up";
  }
}

/**
 * May this spend run on our keys? (pure). A campaign needs the paid plan (trial
 * included); everything is bounded by the state's floor. Spending exactly down to the
 * floor is allowed.
 */
export function soloSpendVerdict(
  plan: SoloPlan,
  balanceCents: string,
  requiredCents: string,
  isCampaignSpend: boolean
): SoloSpendVerdict {
  const floorCents = soloFloorCents(plan);
  if (isCampaignSpend && plan.status === "free") {
    return { allowed: false, floorCents, reason: "paid_plan_required" };
  }
  const after = new Decimal(balanceCents).minus(requiredCents);
  if (after.gte(floorCents)) return { allowed: true, floorCents, reason: null };
  return { allowed: false, floorCents, reason: outReason(plan) };
}

export interface SoloPlanState {
  org_id: string;
  plan: SoloPlanStatus;
  monthly_amount_cents: number;
  balance_cents: string;
  /** Credit still spendable on our keys before the plan's floor (0 when none). */
  credit_left_cents: string;
  /** What the account owes us on our keys (0 when the balance is not negative). */
  debt_cents: string;
  debt_limit_cents: number;
  out_of_credit: boolean;
  out_of_credit_reason: SoloSpendVerdict["reason"];
  may_launch_campaign_on_our_keys: boolean;
  campaign_launch_refused_reason: SoloSpendVerdict["reason"];
  trial_started_at: string | null;
  trial_ends_at: string | null;
  trial_spend_cap_cents: number | null;
  trial_spent_cents: string | null;
  trial_hold_cents: number | null;
  had_trial: boolean;
  current_period_start: string | null;
  current_period_end: string | null;
  next_charge_at: string | null;
  next_charge_cents: number | null;
  /** The public page the out-of-credit notice links to (null when not configured). */
  upgrade_url: string | null;
  /** The one action that gets this account more room, for the notice's link. */
  next_step: {
    action: "start_plan" | "start_paid_now" | "add_layer" | "update_card";
    method: "POST";
    path: string;
    amount_cents: number | null;
  } | null;
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/** The plan state from a plan row and the org's spendable balance (pure). */
export function soloPlanStateOf(orgId: string, plan: SoloPlan, balanceCents: string): SoloPlanState {
  const status = plan.status as SoloPlanStatus;
  const balance = new Decimal(balanceCents);
  const floor = new Decimal(soloFloorCents(plan));
  const out = balance.lte(floor) || status === "past_due";
  const left = Decimal.max(0, status === "free" ? 0 : balance.minus(floor));
  const debt = Decimal.max(0, balance.negated());
  const outReasonValue = out ? outReason(plan) : null;
  const mayLaunch = (status === "trialing" || status === "active") && !out;
  const launchReason = mayLaunch ? null : status === "free" ? "paid_plan_required" : outReasonValue;

  let nextStep: SoloPlanState["next_step"] = null;
  if (status === "free") {
    nextStep = { action: "start_plan", method: "POST", path: "/v1/accounts/solo_plan/start", amount_cents: plan.monthlyAmountCents };
  } else if (status === "trialing") {
    nextStep = { action: "start_paid_now", method: "POST", path: "/v1/accounts/solo_plan/start_now", amount_cents: plan.monthlyAmountCents };
  } else if (status === "active") {
    nextStep = {
      action: "add_layer",
      method: "POST",
      path: "/v1/accounts/solo_plan/layers",
      amount_cents: plan.monthlyAmountCents + SOLO_PLAN_LAYER_CENTS,
    };
  } else {
    nextStep = { action: "update_card", method: "POST", path: "/v1/accounts/card_setup", amount_cents: null };
  }

  const trialSpent =
    status === "trialing" && plan.trialFloorCents !== null
      ? Decimal.max(0, new Decimal(plan.trialFloorCents).plus(SOLO_PLAN_TRIAL_SPEND_CAP_CENTS).minus(balance))
          .toFixed(10)
      : null;

  return {
    org_id: orgId,
    plan: status,
    monthly_amount_cents: plan.monthlyAmountCents,
    balance_cents: balance.toFixed(10),
    credit_left_cents: left.toFixed(10),
    debt_cents: debt.toFixed(10),
    debt_limit_cents: SOLO_PLAN_DEBT_LIMIT_CENTS,
    out_of_credit: out,
    out_of_credit_reason: outReasonValue,
    may_launch_campaign_on_our_keys: mayLaunch,
    campaign_launch_refused_reason: launchReason,
    trial_started_at: iso(plan.trialStartedAt),
    trial_ends_at: iso(plan.trialEndsAt),
    trial_spend_cap_cents: status === "trialing" ? SOLO_PLAN_TRIAL_SPEND_CAP_CENTS : null,
    trial_spent_cents: trialSpent,
    trial_hold_cents: status === "trialing" && plan.trialHoldId ? SOLO_PLAN_BASE_MONTHLY_CENTS : null,
    had_trial: plan.trialStartedAt !== null,
    current_period_start: iso(plan.currentPeriodStart),
    current_period_end: iso(plan.currentPeriodEnd),
    next_charge_at:
      status === "trialing" ? iso(plan.trialEndsAt) : status === "active" ? iso(plan.currentPeriodEnd) : null,
    next_charge_cents: status === "trialing" || status === "active" ? plan.monthlyAmountCents : null,
    upgrade_url: soloUpgradeUrl(orgId),
    next_step: nextStep,
  };
}

/** The plan state, read live (no settle, no write). 404-worthy null when not enrolled. */
export async function readSoloPlanState(orgId: string): Promise<SoloPlanState | null> {
  const plan = await getSoloPlan(orgId);
  if (!plan) return null;
  const snapshot = await computeBalance(orgId);
  return soloPlanStateOf(orgId, plan, snapshot.balanceCents);
}

// --- AI gate (one read per Distry turn, chat-service) -----------------------

export interface SoloAiGate {
  org_id: string;
  /** False for every org not enrolled (legacy, at-cost, agent/API): untouched, nothing else to read. */
  on_solo_plan: boolean;
  plan: SoloPlanStatus | null;
  /** May an AI turn run on our money right now (room above the plan's limit). */
  may_use_our_keys: boolean;
  refused_reason: SoloSpendVerdict["reason"];
  debt_cents: string | null;
  debt_limit_cents: number | null;
  /** The public page the out-of-credit notice links to (null when not configured). */
  upgrade_url: string | null;
  next_step: SoloPlanState["next_step"];
}

/** The upgrade page for the fixed notice: `SOLO_PLAN_UPGRADE_URL`, `{orgId}` substituted. */
export function soloUpgradeUrl(orgId: string): string | null {
  const template = process.env.SOLO_PLAN_UPGRADE_URL?.trim();
  return template ? template.replaceAll("{orgId}", encodeURIComponent(orgId)) : null;
}

/**
 * The per-turn read: is the org on the plan, and may a conversation run on our money
 * now. An org not on the plan answers `on_solo_plan: false` with ONE indexed read (no
 * balance composed). The verdict is the plan's floor: room left above it = yes.
 */
export async function readSoloAiGate(orgId: string): Promise<SoloAiGate> {
  const plan = await getSoloPlan(orgId);
  if (!plan) {
    return {
      org_id: orgId,
      on_solo_plan: false,
      plan: null,
      may_use_our_keys: true,
      refused_reason: null,
      debt_cents: null,
      debt_limit_cents: null,
      upgrade_url: null,
      next_step: null,
    };
  }
  const snapshot = await computeBalance(orgId);
  const state = soloPlanStateOf(orgId, plan, snapshot.balanceCents);
  return {
    org_id: orgId,
    on_solo_plan: true,
    plan: state.plan,
    may_use_our_keys: !state.out_of_credit,
    refused_reason: state.out_of_credit_reason,
    debt_cents: state.debt_cents,
    debt_limit_cents: plan.status === "free" ? SOLO_PLAN_DEBT_LIMIT_CENTS : null,
    upgrade_url: soloUpgradeUrl(orgId),
    next_step: state.next_step,
  };
}

// --- enrol -----------------------------------------------------------------

export const SOLO_NO_ADVANCE_DESCRIPTION = "Onboarding credit advance: none on the solo-founder plan";

/**
 * Put an org on the solo-founder plan (free state). Idempotent. Only an org that has
 * never paid us, holds no subscription and sits on the at-cost or agent/API offer
 * (never a legacy or match account): every existing paying account keeps its offer.
 * Its $5 onboarding advance, if one was written, goes to 0: the plan replaces it with
 * the $2 debt we accept.
 */
export async function enrolSoloPlan(orgId: string, userId: string | null): Promise<SoloPlan> {
  const existing = await getSoloPlan(orgId);
  if (existing) return existing;

  const [account] = await db
    .select({ offer: billingAccounts.freeCreditOffer, paymentMode: billingAccounts.paymentMode })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  if (account) {
    if (account.offer !== AT_COST_FREE_CREDIT_OFFER && account.offer !== AGENT_API_FREE_CREDIT_OFFER) {
      throw new SoloPlanRefused(
        "offer_not_switchable",
        `This organization keeps its current offer (${account.offer}); the solo-founder plan is for new accounts.`
      );
    }
    if (account.paymentMode === "subscription" || (await getLiveSubscription(orgId))) {
      throw new SoloPlanRefused("subscription_exists", "This organization already has a monthly plan.");
    }
    const paid = await sumSucceededTopupsForOrg(orgId);
    if (new Decimal(paid).gt(0)) {
      throw new SoloPlanRefused(
        "existing_paying_org",
        "This organization already pays us; moving it to the solo-founder plan is done by our team."
      );
    }
  }

  const [bonusCode] = await db
    .select({ id: localPromoCodes.id })
    .from(localPromoCodes)
    .where(eq(localPromoCodes.code, ORG_CREATION_BONUS_CODE))
    .limit(1);
  if (!bonusCode) throw new Error(`Promo code seed missing: ${ORG_CREATION_BONUS_CODE}`);

  const startedBy = userId && userId !== PLATFORM_USER_ID ? userId : null;
  const plan = await db.transaction(async (tx) => {
    if (account) {
      await tx
        .update(billingAccounts)
        .set({
          freeCreditOffer: SOLO_FOUNDER_OFFER,
          paymentMode: "prepaid",
          topupAmountCents: null,
          topupThresholdCents: null,
          freeCreditEntitlementCents: 0,
          freeCreditPaidTriggerCents: 0,
          welcomeCompletionEligible: false,
          updatedAt: new Date(),
        })
        .where(eq(billingAccounts.orgId, orgId));
    } else {
      await tx
        .insert(billingAccounts)
        .values({
          orgId,
          freeCreditOffer: SOLO_FOUNDER_OFFER,
          paymentMode: "prepaid",
          freeCreditEntitlementCents: 0,
          freeCreditPaidTriggerCents: 0,
          welcomeCompletionEligible: false,
        })
        .onConflictDoNothing({ target: billingAccounts.orgId });
    }
    // The one-shot (org, org_creation_bonus) row at 0: every later advance path
    // (first touch, trial seed, signup) lands on it and adds nothing.
    await tx
      .insert(localPromos)
      .values({
        orgId,
        userId: PLATFORM_USER_ID,
        amountCents: "0",
        promoCodeId: bonusCode.id,
        description: SOLO_NO_ADVANCE_DESCRIPTION,
      })
      .onConflictDoUpdate({
        target: [localPromos.orgId, localPromos.promoCodeId],
        targetWhere: rawSql`idempotency_key IS NULL`,
        set: { amountCents: "0", description: SOLO_NO_ADVANCE_DESCRIPTION },
      });
    const [row] = await tx
      .insert(soloPlans)
      .values({ orgId, status: "free", startedByUserId: startedBy })
      .onConflictDoNothing({ target: soloPlans.orgId })
      .returning();
    return row ?? null;
  });
  const enrolled = plan ?? (await getSoloPlan(orgId));
  if (!enrolled) throw new Error(`solo plan enrol for org ${orgId} wrote no row`);
  console.log(`[billing-service] solo plan: org ${orgId} enrolled (free, debt limit ${usd(SOLO_PLAN_DEBT_LIMIT_CENTS)})`);
  return enrolled;
}

// --- charges ---------------------------------------------------------------

type ChargeResult = { result: "paid"; reference: string | null } | { result: "declined"; code: string; message: string | null } | { result: "error" };

async function insertCharge(values: {
  plan: SoloPlan;
  kind: "trial_conversion" | "renewal" | "layer" | "first_month";
  periodStart: Date;
  monthlyAmountCents: number;
  amountCents: number;
  unspentDiscountCents?: number;
}): Promise<SoloPlanCharge> {
  const [row] = await db
    .insert(soloPlanCharges)
    .values({
      planId: values.plan.id,
      orgId: values.plan.orgId,
      kind: values.kind,
      periodStart: values.periodStart,
      monthlyAmountCents: values.monthlyAmountCents,
      amountCents: values.amountCents,
      unspentDiscountCents: values.unspentDiscountCents ?? 0,
      status: "pending",
    })
    .onConflictDoNothing({ target: [soloPlanCharges.planId, soloPlanCharges.periodStart, soloPlanCharges.kind] })
    .returning();
  if (row) return row;
  const [existing] = await db
    .select()
    .from(soloPlanCharges)
    .where(
      and(
        eq(soloPlanCharges.planId, values.plan.id),
        eq(soloPlanCharges.periodStart, values.periodStart),
        eq(soloPlanCharges.kind, values.kind)
      )
    )
    .limit(1);
  if (!existing) throw new Error(`solo plan charge for plan ${values.plan.id} vanished`);
  return existing;
}

async function markCharge(charge: SoloPlanCharge, now: Date, result: ChargeResult): Promise<void> {
  const attempt = charge.attemptCount + 1;
  if (result.result === "paid") {
    await db
      .update(soloPlanCharges)
      .set({ status: "paid", attemptCount: attempt, lastAttemptAt: now, paidAt: now, reference: result.reference, failureCode: null })
      .where(eq(soloPlanCharges.id, charge.id));
  } else if (result.result === "declined") {
    await db
      .update(soloPlanCharges)
      .set({
        status: "failed",
        attemptCount: attempt,
        lastAttemptAt: now,
        firstFailedAt: charge.firstFailedAt ?? now,
        failureCode: result.code,
      })
      .where(eq(soloPlanCharges.id, charge.id));
  } else {
    await db.update(soloPlanCharges).set({ lastAttemptAt: now }).where(eq(soloPlanCharges.id, charge.id));
  }
}

/** One off-session charge through the ordinary path; a refusal and an outage stay apart. */
async function chargeCard(plan: SoloPlan, charge: SoloPlanCharge, now: Date): Promise<ChargeResult> {
  const attempt = charge.attemptCount + 1;
  let result: ChargeResult;
  try {
    const outcome = await withTimeout(
      CHARGE_TIMEOUT_MS,
      reloadOffSession(plan.orgId, charge.amountCents, `solo-plan:${charge.id}:${attempt}`, {
        reason: "solo_plan",
        solo_plan_id: plan.id,
        charge_kind: charge.kind,
      })
    );
    result =
      outcome.status === "succeeded"
        ? { result: "paid", reference: outcome.reference ?? null }
        : { result: "declined", code: outcome.failure_code ?? "declined", message: outcome.failure_reason ?? null };
  } catch (err) {
    const status = upstreamStatus(err);
    if (status === 402 || status === 404 || status === 409) {
      result = { result: "declined", code: `http_${status}`, message: null };
    } else {
      console.error(`[billing-service] solo plan charge for org ${plan.orgId} could not be attempted:`, err);
      result = { result: "error" };
    }
  }
  await markCharge(charge, now, result);
  return result;
}

/** Pay the trial conversion by capturing the trial hold; null = the hold cannot pay it. */
async function captureTrialHold(plan: SoloPlan, amountCents: number): Promise<string | null | undefined> {
  if (!plan.trialHoldId) return undefined;
  let captured: CardHold | null;
  try {
    captured = await captureCardHold(plan.orgId, plan.trialHoldId, amountCents);
  } catch (err) {
    console.error(`[billing-service] solo plan: trial hold capture failed for org ${plan.orgId}, charging the card instead:`, err);
    return undefined;
  }
  if (!captured || captured.status !== "captured") {
    console.warn(
      `[billing-service] solo plan: trial hold ${plan.trialHoldId} not captured for org ${plan.orgId} (${captured?.status ?? "not live"}), charging the card instead`
    );
    return undefined;
  }
  const reference =
    (captured as CardHold & { payment_reference?: string | null }).payment_reference ?? captured.reference ?? captured.id;
  await recordChargeSignal(plan.orgId, reference, "solo_plan", amountCents);
  return reference;
}

/**
 * Trial -> paid: the $99 is taken (the hold captured, else the card charged), the
 * first cycle starts NOW (trial end, or a "start now" click). Debt is repaid by
 * arithmetic. Refused -> past_due on the same cycle (its retries are the sweep's).
 */
async function convertTrial(plan: SoloPlan, periodStart: Date, now: Date): Promise<SoloPlan> {
  const amount = plan.monthlyAmountCents;
  const charge = await insertCharge({ plan, kind: "trial_conversion", periodStart: plan.trialStartedAt ?? now, monthlyAmountCents: amount, amountCents: amount });
  let result: ChargeResult;
  if (charge.status === "paid") {
    result = { result: "paid", reference: charge.reference };
  } else {
    const fromHold = await captureTrialHold(plan, amount);
    if (fromHold !== undefined) {
      result = { result: "paid", reference: fromHold };
      await markCharge(charge, now, result);
    } else {
      result = await chargeCard(plan, charge, now);
    }
  }
  if (result.result === "error") return plan;
  const paid = result.result === "paid";
  const [next] = await db
    .update(soloPlans)
    .set({
      status: paid ? "active" : "past_due",
      trialEndsAt: periodStart,
      trialFloorCents: null,
      trialHoldId: null,
      currentPeriodStart: periodStart,
      currentPeriodEnd: nextPeriodEnd(periodStart, periodStart),
      renewalAnchorAt: periodStart,
      updatedAt: now,
    })
    .where(eq(soloPlans.id, plan.id))
    .returning();
  console.log(`[billing-service] solo plan: org ${plan.orgId} trial ended, ${paid ? `paid ${usd(amount)}` : "charge refused (past due)"}`);
  if (paid) notifyOwnerBillingEvent({ orgId: plan.orgId, emoji: "💳", text: `Solo plan: trial converted, ${usd(amount)} paid.` });
  return next;
}

/** Expire the credit left unspent at a cycle end (once per boundary). */
async function expireUnspentAt(plan: SoloPlan, boundary: Date): Promise<void> {
  const [done] = await db
    .select({ id: subscriptionCreditExpiries.id })
    .from(subscriptionCreditExpiries)
    .where(and(eq(subscriptionCreditExpiries.subscriptionId, plan.id), eq(subscriptionCreditExpiries.boundaryAt, boundary)))
    .limit(1);
  if (done) return;
  const snapshot = await computeBalance(plan.orgId);
  const unspent = Decimal.max(0, new Decimal(snapshot.balanceCents));
  await db
    .insert(subscriptionCreditExpiries)
    .values({ orgId: plan.orgId, subscriptionId: plan.id, boundaryAt: boundary, amountCents: unspent.toFixed(10) })
    .onConflictDoNothing({ target: [subscriptionCreditExpiries.subscriptionId, subscriptionCreditExpiries.boundaryAt] });
  if (unspent.gt(0)) {
    console.log(`[billing-service] solo plan: org ${plan.orgId} ${unspent.toFixed(2)} cents unspent at cycle end, expired`);
  }
}

/** A cycle ended: expire what is left, then charge the next cycle. */
async function renew(plan: SoloPlan, now: Date): Promise<SoloPlan> {
  const boundary = plan.currentPeriodEnd;
  if (!boundary) throw new Error(`solo plan ${plan.id} is active with no period end`);
  await expireUnspentAt(plan, boundary);
  const charge = await insertCharge({ plan, kind: "renewal", periodStart: boundary, monthlyAmountCents: plan.monthlyAmountCents, amountCents: plan.monthlyAmountCents });
  const result = charge.status === "paid" ? ({ result: "paid", reference: charge.reference } as ChargeResult) : await chargeCard(plan, charge, now);
  if (result.result === "error") return plan;
  const anchor = plan.renewalAnchorAt ?? boundary;
  const [next] = await db
    .update(soloPlans)
    .set({
      status: result.result === "paid" ? "active" : "past_due",
      currentPeriodStart: boundary,
      currentPeriodEnd: nextPeriodEnd(boundary, anchor),
      updatedAt: now,
    })
    .where(eq(soloPlans.id, plan.id))
    .returning();
  return next;
}

/** Retry a refused charge on its rungs (+1d, +3d, +7d, +14d); out of rungs = back to free. */
async function retryPastDue(plan: SoloPlan, now: Date): Promise<SoloPlan> {
  const [charge] = await db
    .select()
    .from(soloPlanCharges)
    .where(and(eq(soloPlanCharges.planId, plan.id), eq(soloPlanCharges.status, "failed")))
    .orderBy(rawSql`${soloPlanCharges.createdAt} DESC`)
    .limit(1);
  const endToFree = async () => {
    const [ended] = await db
      .update(soloPlans)
      .set({ status: "free", currentPeriodStart: null, currentPeriodEnd: null, renewalAnchorAt: null, updatedAt: now })
      .where(eq(soloPlans.id, plan.id))
      .returning();
    console.warn(`[billing-service] solo plan: org ${plan.orgId} payment never went through, back to the free state`);
    return ended;
  };
  if (!charge || !charge.firstFailedAt) return endToFree();
  if (isPermanentDecline(charge.failureCode)) return endToFree();
  const due = nextRetryDueAt(charge.attemptCount, charge.firstFailedAt);
  if (!due) return endToFree();
  if (due > now) return plan;
  const result = await chargeCard(plan, charge, now);
  if (result.result !== "paid") return plan;
  const [next] = await db
    .update(soloPlans)
    .set({ status: "active", updatedAt: now })
    .where(eq(soloPlans.id, plan.id))
    .returning();
  return next;
}

// --- start -----------------------------------------------------------------

export type SoloStartResult =
  | {
      state: "card_required";
      cardSetup: Record<string, unknown>;
      checkoutUrl: string | null;
      cardRefusedReason: "prepaid_card" | null;
      plan: SoloPlan;
    }
  | { state: "started"; plan: SoloPlan };

function checkoutUrlOf(cardSetup: Record<string, unknown>): string | null {
  return typeof cardSetup.url === "string" ? cardSetup.url : null;
}

/**
 * Start the paid plan. Enrols the org first when needed. No chargeable card (or a
 * prepaid one) -> the card page to open, and the plan starts once the card is on
 * file (this call again, or the next read / sweep within 48 h). With a card:
 *   - never had a trial -> a $99 HOLD, then a 3-day trial capped at $10;
 *   - had one -> the first month charged now.
 */
export async function startSoloPlan(params: {
  orgId: string;
  identity: IdentityHeaders;
  userId: string | null;
  returnUrl?: string;
  uiMode?: "hosted" | "embedded";
  session?: "on_session" | "off_session";
  now?: Date;
}): Promise<SoloStartResult> {
  const { orgId } = params;
  const now = params.now ?? new Date();
  let plan = await enrolSoloPlan(orgId, params.userId);
  if (plan.status !== "free") {
    throw new SoloPlanRefused("plan_exists", `This account is already on the plan (${plan.status}).`);
  }

  let cardRefusedReason: "prepaid_card" | null = null;
  if (await confirmChargeableCard(orgId)) {
    if (!(await savedCardIsPrepaid(orgId))) {
      plan = await startWithCard(plan, params.session ?? "on_session", now);
      return { state: "started", plan };
    }
    cardRefusedReason = "prepaid_card";
  }

  await ensureOrgStripeCustomer(params.identity);
  const cardSetup = await getCardSetup(orgId, params.returnUrl, undefined, "usd", params.uiMode, params.userId ?? undefined);
  const [stamped] = await db
    .update(soloPlans)
    .set({ startRequestedAt: now, updatedAt: now })
    .where(eq(soloPlans.id, plan.id))
    .returning();
  return { state: "card_required", cardSetup, checkoutUrl: checkoutUrlOf(cardSetup), cardRefusedReason, plan: stamped ?? plan };
}

async function startWithCard(plan: SoloPlan, session: "on_session" | "off_session", now: Date): Promise<SoloPlan> {
  const orgId = plan.orgId;
  if (plan.trialStartedAt === null) {
    const saved = await getSavedPaymentMethod(orgId);
    const methodId = saved.method?.id ?? "unknown";
    const hold = await placeHoldRetryingPending(
      orgId,
      SOLO_PLAN_BASE_MONTHLY_CENTS,
      `solo-plan-trial-hold:${orgId}:${methodId}:${now.toISOString().slice(0, 10)}:${session}`,
      { billing_purpose: SOLO_PLAN_TRIAL_HOLD_PURPOSE, reason: "solo_plan_trial" },
      session
    );
    if (hold.status === "requires_action") {
      if (!hold.client_secret) throw new Error(`stripe-service hold ${hold.id} for org ${orgId} requires action but carries no client_secret`);
      throw new SoloPlanRefused("card_hold_requires_action", "Your bank asks you to confirm the card.", {
        client_secret: hold.client_secret,
      });
    }
    if (hold.status !== "held") {
      throw new SoloPlanRefused("card_hold_refused", refusedHoldMessage(hold), { decline_code: hold.failure?.code ?? null });
    }
    const snapshot = await computeBalance(orgId);
    const trialEnd = new Date(now.getTime() + SOLO_PLAN_TRIAL_DAYS * DAY_MS);
    const [started] = await db
      .update(soloPlans)
      .set({
        status: "trialing",
        monthlyAmountCents: SOLO_PLAN_BASE_MONTHLY_CENTS,
        trialStartedAt: now,
        trialEndsAt: trialEnd,
        trialFloorCents: new Decimal(snapshot.balanceCents).minus(SOLO_PLAN_TRIAL_SPEND_CAP_CENTS).toFixed(10),
        trialHoldId: hold.id,
        currentPeriodStart: now,
        currentPeriodEnd: trialEnd,
        startRequestedAt: null,
        updatedAt: now,
      })
      .where(and(eq(soloPlans.id, plan.id), eq(soloPlans.status, "free")))
      .returning();
    if (!started) throw new SoloPlanRefused("plan_exists", "This account is already on the plan.");
    console.log(`[billing-service] solo plan: org ${orgId} trial started, hold ${hold.id} ${usd(hold.amount)}`);
    notifyOwnerBillingEvent({
      orgId,
      emoji: "🧪",
      text: `Solo plan: ${SOLO_PLAN_TRIAL_DAYS}-day trial started ($99 card hold, $10 cap), then ${usd(SOLO_PLAN_BASE_MONTHLY_CENTS)}/month.`,
    });
    return started;
  }

  // Trial already used: the first month is charged now; a refusal starts nothing.
  const amount = plan.monthlyAmountCents;
  const charge = await insertCharge({ plan, kind: "first_month", periodStart: now, monthlyAmountCents: amount, amountCents: amount });
  const result = await chargeCard(plan, charge, now);
  if (result.result === "error") throw new SoloPlanRefused("charge_unavailable", "The card could not be charged right now. Try again in a minute.");
  if (result.result === "declined") {
    throw new SoloPlanRefused("first_charge_declined", "The card was not charged, so the plan did not start. Try another card.", {
      decline_code: result.code,
    });
  }
  const [active] = await db
    .update(soloPlans)
    .set({
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd: nextPeriodEnd(now, now),
      renewalAnchorAt: now,
      startRequestedAt: null,
      updatedAt: now,
    })
    .where(eq(soloPlans.id, plan.id))
    .returning();
  notifyOwnerBillingEvent({ orgId, emoji: "💳", text: `Solo plan started: ${usd(amount)} paid.` });
  return active;
}

/** Trial -> paid NOW (« start now »): the hold is captured today, the cycle starts today. */
export async function startSoloPlanNow(orgId: string, now: Date = new Date()): Promise<SoloPlan> {
  const plan = await getSoloPlan(orgId);
  if (!plan) throw new SoloPlanRefused("not_enrolled", "This account is not on the solo-founder plan.");
  if (plan.status !== "trialing") throw new SoloPlanRefused("not_trialing", "Only a plan in its trial can start now.");
  const next = await convertTrial(plan, now, now);
  if (next.status === "active") return next;
  if (next.status === "trialing") throw new SoloPlanRefused("charge_unavailable", "The card could not be charged right now. Try again in a minute.");
  throw new SoloPlanRefused("first_charge_declined", "The card refused the charge. Update the card.");
}

// --- layers ----------------------------------------------------------------

export interface LayerResult {
  plan: SoloPlan;
  chargedCents: number;
  unspentDiscountCents: number;
}

/**
 * +$100/month, at once: charge new amount − credit left unspent this cycle; the cycle
 * restarts now with the new amount as its credit. A double click is refused while the
 * first charge runs (`change_in_progress`).
 */
export async function addSoloPlanLayer(orgId: string, now: Date = new Date()): Promise<LayerResult> {
  const plan = await getSoloPlan(orgId);
  if (!plan) throw new SoloPlanRefused("not_enrolled", "This account is not on the solo-founder plan.");
  if (plan.status !== "active") {
    throw new SoloPlanRefused(
      "not_active",
      plan.status === "trialing"
        ? "Start the paid plan first (start now), then add budget."
        : plan.status === "free"
          ? "Start the plan first."
          : "Update the card first: the last charge did not go through."
    );
  }
  const [claimed] = await db
    .update(soloPlans)
    .set({ pendingChangeAt: now })
    .where(
      and(
        eq(soloPlans.id, plan.id),
        eq(soloPlans.status, "active"),
        or(isNull(soloPlans.pendingChangeAt), lt(soloPlans.pendingChangeAt, new Date(now.getTime() - PENDING_CHANGE_TTL_MS)))
      )
    )
    .returning();
  if (!claimed) throw new SoloPlanRefused("change_in_progress", "A budget change is already going through.");

  const release = () => db.update(soloPlans).set({ pendingChangeAt: null }).where(eq(soloPlans.id, plan.id));
  try {
    const snapshot = await computeBalance(orgId);
    const unspent = Decimal.max(0, new Decimal(snapshot.balanceCents));
    const newAmount = claimed.monthlyAmountCents + SOLO_PLAN_LAYER_CENTS;
    let chargeCents = new Decimal(newAmount).minus(unspent).ceil().toNumber();
    if (chargeCents < MIN_CHARGE_CENTS) chargeCents = 0;
    const discount = newAmount - chargeCents;

    const charge = await insertCharge({
      plan: claimed,
      kind: "layer",
      periodStart: now,
      monthlyAmountCents: newAmount,
      amountCents: chargeCents,
      unspentDiscountCents: Math.max(0, Math.floor(unspent.toNumber())),
    });
    if (chargeCents > 0) {
      const result = await chargeCard(claimed, charge, now);
      if (result.result === "error") {
        throw new SoloPlanRefused("charge_unavailable", "The card could not be charged right now. Try again in a minute.");
      }
      if (result.result === "declined") {
        throw new SoloPlanRefused("layer_charge_declined", "The card refused the charge. Your plan is unchanged.", {
          decline_code: result.code,
        });
      }
    } else {
      // Credit already covers the new month: anything above it is the old cycle's, lost.
      await markCharge(charge, now, { result: "paid", reference: null });
      const excess = unspent.minus(newAmount);
      if (excess.gt(0)) {
        await db
          .insert(subscriptionCreditExpiries)
          .values({ orgId, subscriptionId: plan.id, boundaryAt: now, amountCents: excess.toFixed(10) })
          .onConflictDoNothing({ target: [subscriptionCreditExpiries.subscriptionId, subscriptionCreditExpiries.boundaryAt] });
      }
    }
    const [next] = await db
      .update(soloPlans)
      .set({
        monthlyAmountCents: newAmount,
        currentPeriodStart: now,
        currentPeriodEnd: nextPeriodEnd(now, now),
        renewalAnchorAt: now,
        pendingChangeAt: null,
        updatedAt: now,
      })
      .where(eq(soloPlans.id, plan.id))
      .returning();
    console.log(
      `[billing-service] solo plan: org ${orgId} +layer -> ${usd(newAmount)}/month, charged ${usd(chargeCents)} (${usd(discount)} unspent credit deducted)`
    );
    notifyOwnerBillingEvent({
      orgId,
      emoji: "📈",
      text: `Solo plan: budget raised to ${usd(newAmount)}/month, ${usd(chargeCents)} paid now (unspent credit deducted).`,
    });
    return { plan: next, chargedCents: chargeCents, unspentDiscountCents: discount };
  } catch (err) {
    await release();
    throw err;
  }
}

// --- settle ----------------------------------------------------------------

/**
 * Bring one plan up to date: start a requested plan whose card has landed, end a
 * trial, renew cycles that ended, retry a refused charge. Called by the customer read
 * and the hourly sweep.
 */
export async function settleSoloPlan(orgId: string, now: Date = new Date()): Promise<SoloPlan | null> {
  let plan = await getSoloPlan(orgId);
  if (!plan) return null;

  if (plan.status === "free" && plan.startRequestedAt) {
    if (now.getTime() - plan.startRequestedAt.getTime() > START_REQUEST_TTL_MS) {
      [plan] = await db.update(soloPlans).set({ startRequestedAt: null }).where(eq(soloPlans.id, plan.id)).returning();
    } else if ((await confirmChargeableCard(orgId)) && !(await savedCardIsPrepaid(orgId))) {
      try {
        plan = await startWithCard(plan, "off_session", now);
      } catch (err) {
        if (!(err instanceof SoloPlanRefused)) throw err;
        console.warn(`[billing-service] solo plan: auto-start for org ${orgId} not done (${err.code}); the customer starts it`);
      }
    }
  }

  if (plan.status === "trialing" && plan.trialEndsAt && plan.trialEndsAt <= now) {
    // The first cycle is dated from the trial end (its anniversary), whenever the tick ran.
    plan = await convertTrial(plan, plan.trialEndsAt, now);
  }

  for (let i = 0; i < MAX_BOUNDARIES_PER_SETTLE; i++) {
    if (plan.status !== "active" || !plan.currentPeriodEnd || plan.currentPeriodEnd > now) break;
    plan = await renew(plan, now);
  }

  if (plan.status === "past_due") plan = await retryPastDue(plan, now);
  return plan;
}

/** Hourly: settle every plan that has something due. Isolated per org. */
export async function runSoloPlanSweep(now: Date = new Date()): Promise<{ checked: number; failed: number }> {
  const due = await db
    .select({ orgId: soloPlans.orgId })
    .from(soloPlans)
    .where(
      or(
        and(eq(soloPlans.status, "free"), rawSql`${soloPlans.startRequestedAt} IS NOT NULL`),
        and(eq(soloPlans.status, "trialing"), lt(soloPlans.trialEndsAt, now)),
        and(eq(soloPlans.status, "active"), lt(soloPlans.currentPeriodEnd, now)),
        eq(soloPlans.status, "past_due")
      )
    );
  let failed = 0;
  for (const { orgId } of due) {
    try {
      await settleSoloPlan(orgId, now);
    } catch (err) {
      failed++;
      console.error(`[billing-service] solo plan sweep failed for org ${orgId}:`, err);
    }
  }
  return { checked: due.length, failed };
}
