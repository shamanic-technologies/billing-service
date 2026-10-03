/**
 * SUBSCRIPTION — the third payment mode, OWNED BY BILLING (migrations 0055, 0056).
 *
 * Owner's model (2026-10-01):
 *  - The customer picks a monthly amount ($99, $199, $299, ... = 9900 + k×10000)
 *    and saves a card. Card MANDATORY. A 3-day free trial starts at once with $99
 *    of credit (the `subscription_trial` grant, "topped up TO" $99 so no other
 *    gift stacks on it), at our expense if they cancel during the trial.
 *  - At trial end, then every month on the ANNIVERSARY of that date, billing
 *    charges the monthly amount on the saved card. PREPAID: the charge is an
 *    ordinary succeeded payment, which `credited` already counts (once, keyed by
 *    the payment). Nothing here grants credit for it.
 *  - Credits EXPIRE: at every period boundary (trial end included), whatever was
 *    not spent is expired before the new period's charge lands
 *    (`subscription_credit_expiries`, applied on the usage side like a staff
 *    debit). A negative balance never expires. A cancelled subscription expires
 *    its remainder when its last paid period ends.
 *  - When credit runs out, sending stops (floor 0, no reload) and the customer
 *    gets the "all your outbound went out" email (lib/subscription-notifications).
 *  - Amount change: any ladder value, up or down, from the next charge; not while
 *    trialing. Cancel = no further charge (at period end; immediately when
 *    past_due). Resume undoes a pending cancel.
 *
 * WHY BILLING OWNS IT. The default acquirer (Revolut Business) has no
 * subscription object reachable through stripe-service, and billing already
 * charges off-session through one acquirer-neutral surface (lib/reload). So a
 * subscription here is a schedule billing keeps and a charge it makes, the same
 * on every acquirer. It names no vendor.
 *
 * A REFUSED charge walks the reload sweep's spaced rungs (+1d, +3d, +7d, +14d,
 * anchored on the first refusal), status `past_due` meanwhile, no new credit.
 * A card the issuer called lost/stolen/closed (or the last rung) ends the
 * subscription. A charge that never reached an acquirer (an outage) consumes no
 * rung and is retried on the next tick.
 *
 * PLANS PER BRAND x OFFER (owner decision 2026-10-03, migration 0058). An org holds
 * one live plan per (brand, offer). The onboarding plan (checkout + start below,
 * 3-day trial once per org) carries no brand/offer and is attributed to the org's
 * first brand x offer on first read (lib/subscription-plans). A plan bought from
 * the dashboard for another brand x offer (`startPlanForOffer`) has NO trial: its
 * first month is charged at once on the card already saved. Every plan runs its
 * own calendar, charges and retries; the credit they buy is ONE org balance.
 * The org-level routes act on the PRIMARY plan (the oldest live one), which for
 * an org holding a single plan is that plan, exactly as before.
 *
 * FLOW: `requestSubscription` (checkout) records the chosen amount and hands back
 * the ordinary card-setup descriptor when no chargeable card is on file. The
 * subscription STARTS when a chargeable card is confirmed: `startSubscription`
 * (the dashboard calls it once the card form completes), any read of the
 * subscription, or the hourly sweep. Ticks are idempotent: every state change is
 * keyed (one charge row per period, one expiry per boundary).
 */

import { and, asc, desc, eq, gte, isNotNull, ne, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  PLATFORM_USER_ID,
  SUBSCRIPTION_TRIAL_CODE,
  subscriptionCharges,
  subscriptionCreditExpiries,
  subscriptions,
  type Subscription,
  type SubscriptionCharge,
} from "../db/schema.js";
import { GrantPromoCodeMissingError, sumLocalPromoCreditsForOrg } from "./promos.js";
import { computeBalance } from "./balance.js";
import { reloadOffSession } from "./reload.js";
import { isPermanentDecline } from "./card-usability.js";
import { nextRetryDueAt, MAX_ATTEMPTS_PER_STREAK } from "./campaign-reload-sweep.js";
import {
  authorizeRecurringCharges,
  getCardSetup,
  getSavedPaymentMethod,
  LEGACY_PM_GATE_ACQUIRER,
  sumSucceededTopupsForOrg,
} from "./stripe-service-client.js";
import { ensureOrgStripeCustomer } from "./account.js";
import { nextPeriodEnd, renewalAnchor } from "./subscription-schedule.js";
import { attributeUnassignedPlan, isOrgOfferOnBrand } from "./subscription-plans.js";

export { nextPeriodEnd } from "./subscription-schedule.js";

/** $99/month: the smallest plan. */
export const SUBSCRIPTION_BASE_MONTHLY_CENTS = 9900;
/** Plans move in $100 steps: $99, $199, $299, … */
export const SUBSCRIPTION_STEP_CENTS = 10000;
/** Free trial before the first charge. */
export const SUBSCRIPTION_TRIAL_DAYS = 3;
/** A checkout nobody completed is forgotten after this. */
export const ABANDONED_CHECKOUT_MS = 48 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHARGE_TIMEOUT_MS = 30_000;
/** Safety bound on boundaries walked in one tick (a month each; normally 0 or 1). */
const MAX_BOUNDARIES_PER_TICK = 3;

/** A monthly amount the ladder allows: $99 + k × $100, k ≥ 0. */
export function isValidMonthlyAmount(cents: number): boolean {
  return (
    Number.isInteger(cents) &&
    cents >= SUBSCRIPTION_BASE_MONTHLY_CENTS &&
    (cents - SUBSCRIPTION_BASE_MONTHLY_CENTS) % SUBSCRIPTION_STEP_CENTS === 0
  );
}

/** Why a subscription action was refused. Stable codes a caller branches on. */
export type SubscriptionRefusalCode =
  | "subscription_exists"
  | "existing_paying_org"
  | "card_required"
  | "first_charge_declined"
  | "no_subscription"
  | "subscription_trialing"
  | "subscription_not_active"
  | "subscription_cancel_pending"
  | "subscription_not_cancel_pending"
  | "amount_unchanged"
  | "plan_exists_for_offer"
  | "offer_not_found"
  | "charge_unavailable";

export class SubscriptionRefused extends Error {
  readonly code: SubscriptionRefusalCode;
  readonly status: 404 | 409 | 502;
  constructor(code: SubscriptionRefusalCode, message: string, status: 404 | 409 | 502 = 409) {
    super(message);
    this.name = "SubscriptionRefused";
    this.code = code;
    this.status = status;
  }
}

// --- reads -----------------------------------------------------------------

/** The org's subscription that has not ended, or null. */
export async function getLiveSubscription(orgId: string): Promise<Subscription | null> {
  const [row] = await listLiveSubscriptions(orgId);
  return row ?? null;
}

/** Every plan of the org that has not ended, oldest first (the first is the PRIMARY). */
export async function listLiveSubscriptions(orgId: string): Promise<Subscription[]> {
  return db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.orgId, orgId), ne(subscriptions.status, "canceled")))
    .orderBy(asc(subscriptions.createdAt), asc(subscriptions.id));
}

/** Every plan the org ever held, oldest first. */
export async function listAllSubscriptions(orgId: string): Promise<Subscription[]> {
  return db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.orgId, orgId))
    .orderBy(asc(subscriptions.createdAt), asc(subscriptions.id));
}

/** The org's newest subscription of any status, or null when it never had one. */
export async function getLatestSubscription(orgId: string): Promise<Subscription | null> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.orgId, orgId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  return row ?? null;
}

async function getCharge(subscriptionId: string, periodStart: Date): Promise<SubscriptionCharge | null> {
  const [row] = await db
    .select()
    .from(subscriptionCharges)
    .where(
      and(
        eq(subscriptionCharges.subscriptionId, subscriptionId),
        eq(subscriptionCharges.periodStart, periodStart)
      )
    )
    .limit(1);
  return row ?? null;
}

/** The charge of the subscription's current period, or null (trialing, or not billed yet). */
export async function getCurrentCharge(sub: Subscription): Promise<SubscriptionCharge | null> {
  return getCharge(sub.id, sub.currentPeriodStart);
}

// --- the trial grant -------------------------------------------------------

async function requireTrialCode() {
  const [code] = await db
    .select()
    .from(localPromoCodes)
    .where(eq(localPromoCodes.code, SUBSCRIPTION_TRIAL_CODE))
    .limit(1);
  if (!code) throw new GrantPromoCodeMissingError(SUBSCRIPTION_TRIAL_CODE);
  return code;
}

/** The trial grant this org holds (cents), or null when it never received one. */
export async function getSubscriptionTrialGrantCents(orgId: string): Promise<number | null> {
  const [row] = await db
    .select({ amountCents: localPromos.amountCents })
    .from(localPromos)
    .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
    .where(and(eq(localPromos.orgId, orgId), eq(localPromoCodes.code, SUBSCRIPTION_TRIAL_CODE)))
    .limit(1);
  return row ? Number(row.amountCents) : null;
}

/**
 * Top the org's free credit up to the trial amount, ONCE per org:
 * max(0, trial amount − every credit already granted). A 0 row is still written:
 * it is the "had its trial" marker, and the partial unique (org, promo_code)
 * index makes a replay a no-op.
 */
export async function grantSubscriptionTrial(
  orgId: string
): Promise<{ grantedCents: number; alreadyGranted: boolean }> {
  const code = await requireTrialCode();
  const existing = await getSubscriptionTrialGrantCents(orgId);
  if (existing !== null) return { grantedCents: existing, alreadyGranted: true };

  const gifted = Number(await sumLocalPromoCreditsForOrg(orgId));
  const amount = Math.max(0, Math.round(code.amountCents - gifted));

  const inserted = await db
    .insert(localPromos)
    .values({
      orgId,
      userId: PLATFORM_USER_ID,
      amountCents: String(amount),
      promoCodeId: code.id,
      description: `Subscription trial credit: $${(amount / 100).toFixed(2)}`,
    })
    .onConflictDoNothing({
      target: [localPromos.orgId, localPromos.promoCodeId],
      where: rawSql`idempotency_key IS NULL`,
    })
    .returning({ amountCents: localPromos.amountCents });

  if (inserted.length > 0) {
    console.log(`[billing-service] subscription trial: org ${orgId} granted ${amount} cents`);
    return { grantedCents: amount, alreadyGranted: false };
  }
  const raced = await getSubscriptionTrialGrantCents(orgId);
  return { grantedCents: raced ?? 0, alreadyGranted: true };
}

// --- card ------------------------------------------------------------------

/**
 * Does the org hold a card billing may charge with nobody present? The same bar
 * arming automatic top-up clears: a saved method, and on any acquirer other than
 * the legacy one, that acquirer's own recurring-charge authorization. Throws when
 * we could not ask: an unknown answer is not a yes.
 */
export async function confirmChargeableCard(orgId: string): Promise<boolean> {
  const answer = await getSavedPaymentMethod(orgId);
  if (!answer.saved) return false;
  if (answer.acquirer === LEGACY_PM_GATE_ACQUIRER) return true;
  return (await authorizeRecurringCharges(orgId)).authorized;
}

// --- entering --------------------------------------------------------------

async function assertMayEnter(orgId: string): Promise<void> {
  const live = await getLiveSubscription(orgId);
  if (live) {
    throw new SubscriptionRefused(
      "subscription_exists",
      `This organization already has a subscription (${live.status}).`
    );
  }
  const [account] = await db
    .select({ paymentMode: billingAccounts.paymentMode })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  if (account && account.paymentMode !== "subscription") {
    const paid = await sumSucceededTopupsForOrg(orgId);
    if (Number(paid) > 0) {
      throw new SubscriptionRefused(
        "existing_paying_org",
        `This organization already pays as ${account.paymentMode}; moving it to a subscription is done by our team.`
      );
    }
  }
}

/** Has this org ever had a trial (a grant, or any subscription that started with one)? */
async function hadTrial(orgId: string): Promise<boolean> {
  if ((await getSubscriptionTrialGrantCents(orgId)) !== null) return true;
  const [row] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.orgId, orgId), isNotNull(subscriptions.trialEndsAt)))
    .limit(1);
  return !!row;
}

export interface SubscriptionRequest {
  monthlyAmountCents: number;
  trialDays: number | null;
  /** False when a chargeable card is already on file: call start right away. */
  cardRequired: boolean;
  /** The ordinary card-setup descriptor (as POST /v1/accounts/card_setup), present when a card is required. */
  cardSetup: Record<string, unknown> | null;
}

/**
 * The checkout: record the chosen amount and, when no chargeable card is on file,
 * hand back the card-setup descriptor (Revolut widget or Stripe form, whichever
 * acquirer holds the org). Nothing is charged here.
 */
export async function requestSubscription(params: {
  orgId: string;
  identity: Record<string, string>;
  monthlyAmountCents: number;
  uiMode?: "hosted" | "embedded";
  returnUrl?: string;
  now?: Date;
}): Promise<SubscriptionRequest> {
  const { orgId } = params;
  await assertMayEnter(orgId);

  await db
    .update(billingAccounts)
    .set({
      subscriptionCheckoutStartedAt: params.now ?? new Date(),
      subscriptionRequestedAmountCents: params.monthlyAmountCents,
    })
    .where(eq(billingAccounts.orgId, orgId));

  const trialDays = (await hadTrial(orgId)) ? null : SUBSCRIPTION_TRIAL_DAYS;
  if (await confirmChargeableCard(orgId)) {
    return { monthlyAmountCents: params.monthlyAmountCents, trialDays, cardRequired: false, cardSetup: null };
  }

  // An org on the legacy acquirer needs its customer before a card session.
  await ensureOrgStripeCustomer(params.identity);
  const cardSetup = await getCardSetup(
    orgId,
    params.returnUrl,
    undefined,
    "usd",
    params.uiMode,
    params.identity["x-user-id"]
  );
  return { monthlyAmountCents: params.monthlyAmountCents, trialDays, cardRequired: true, cardSetup };
}

/** Enter subscription mode: set the mode, disarm auto top-up, clear the checkout stamp. */
async function enterSubscriptionMode(orgId: string): Promise<void> {
  await db
    .update(billingAccounts)
    .set({
      paymentMode: "subscription",
      topupAmountCents: null,
      topupThresholdCents: null,
      subscriptionCheckoutStartedAt: null,
      subscriptionRequestedAmountCents: null,
      updatedAt: new Date(),
    })
    .where(eq(billingAccounts.orgId, orgId));
}

/**
 * Start the subscription once a chargeable card is on file. With a trial (once per
 * org): status trialing for 3 days, $99 trial credit, nothing charged. Without
 * (the org already had its trial): the first month is charged now, and a refusal
 * starts nothing (409 first_charge_declined).
 */
export async function startSubscription(params: {
  orgId: string;
  userId: string | null;
  monthlyAmountCents?: number;
  now?: Date;
}): Promise<Subscription> {
  const { orgId } = params;
  const now = params.now ?? new Date();
  await assertMayEnter(orgId);
  if (!(await confirmChargeableCard(orgId))) {
    throw new SubscriptionRefused("card_required", "Add a card to start the subscription.");
  }

  const [account] = await db
    .select({ requested: billingAccounts.subscriptionRequestedAmountCents })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  const amount =
    params.monthlyAmountCents ?? account?.requested ?? SUBSCRIPTION_BASE_MONTHLY_CENTS;
  if (!isValidMonthlyAmount(amount)) {
    throw new Error(`[billing-service] off-ladder subscription amount ${amount} for org ${orgId}`);
  }
  const startedBy =
    params.userId && params.userId !== PLATFORM_USER_ID ? params.userId : null;

  if (!(await hadTrial(orgId))) {
    const trialEnd = new Date(now.getTime() + SUBSCRIPTION_TRIAL_DAYS * DAY_MS);
    const [sub] = await db
      .insert(subscriptions)
      .values({
        orgId,
        status: "trialing",
        monthlyAmountCents: amount,
        trialStartedAt: now,
        trialEndsAt: trialEnd,
        currentPeriodStart: now,
        currentPeriodEnd: trialEnd,
        startedByUserId: startedBy,
      })
      .returning();
    await enterSubscriptionMode(orgId);
    await grantSubscriptionTrial(orgId);
    console.log(`[billing-service] subscription: org ${orgId} started a trial (${amount} cents/month)`);
    return sub;
  }

  // No trial: the first period starts now and is paid now.
  const periodEnd = nextPeriodEnd(now, now);
  const [sub] = await db
    .insert(subscriptions)
    .values({
      orgId,
      status: "past_due",
      monthlyAmountCents: amount,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      startedByUserId: startedBy,
    })
    .returning();
  const [charge] = await db
    .insert(subscriptionCharges)
    .values({
      subscriptionId: sub.id,
      orgId,
      periodStart: now,
      periodEnd,
      amountCents: amount,
      status: "pending",
    })
    .returning();
  const result = await attemptCharge(sub, charge, now);
  if (result !== "paid") {
    await db
      .update(subscriptions)
      .set({ status: "canceled", endedAt: now, canceledAt: now, updatedAt: now })
      .where(eq(subscriptions.id, sub.id));
    throw new SubscriptionRefused(
      "first_charge_declined",
      "The card was not charged, so the subscription did not start. Try another card."
    );
  }
  const [active] = await db
    .update(subscriptions)
    .set({ status: "active", updatedAt: now })
    .where(eq(subscriptions.id, sub.id))
    .returning();
  await enterSubscriptionMode(orgId);
  return active;
}

/**
 * Buy a plan for one brand x offer from the dashboard: NO trial, the first month
 * is charged at once on the card already on file. Refusals, each named:
 *   offer_not_found (404)       the org does not sell this offer under this brand;
 *   plan_exists_for_offer (409) that brand x offer already has a live plan
 *                               (an unattributed onboarding plan is attributed first);
 *   existing_paying_org (409)   the org pays prepaid/postpaid and holds no plan:
 *                               moving it to plans is done by our team;
 *   card_required (409)         no chargeable card on file;
 *   first_charge_declined (409) the card refused; nothing starts;
 *   charge_unavailable (502)    the charge could not be attempted; nothing starts.
 * On success the org is (or stays) in subscription mode.
 */
export async function startPlanForOffer(params: {
  orgId: string;
  userId: string | null;
  brandId: string;
  offerId: string;
  monthlyAmountCents: number;
  now?: Date;
}): Promise<Subscription> {
  const { orgId, monthlyAmountCents } = params;
  const brandId = params.brandId.toLowerCase();
  const offerId = params.offerId.toLowerCase();
  const now = params.now ?? new Date();
  if (!isValidMonthlyAmount(monthlyAmountCents)) {
    throw new Error(`[billing-service] off-ladder plan amount ${monthlyAmountCents} for org ${orgId}`);
  }
  if (!(await isOrgOfferOnBrand(orgId, brandId, offerId))) {
    throw new SubscriptionRefused(
      "offer_not_found",
      "This offer is not one this organization sells under this brand.",
      404
    );
  }
  await attributeUnassignedPlan(orgId);
  const live = await listLiveSubscriptions(orgId);
  const taken = (): SubscriptionRefused =>
    new SubscriptionRefused("plan_exists_for_offer", "This offer already has a plan.");
  if (live.some((s) => s.brandId === brandId && s.offerId === offerId)) throw taken();
  if (live.length === 0) {
    const [account] = await db
      .select({ paymentMode: billingAccounts.paymentMode })
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);
    if (account && account.paymentMode !== "subscription") {
      const paid = await sumSucceededTopupsForOrg(orgId);
      if (Number(paid) > 0) {
        throw new SubscriptionRefused(
          "existing_paying_org",
          `This organization already pays as ${account.paymentMode}; moving it to a plan is done by our team.`
        );
      }
    }
  }
  if (!(await confirmChargeableCard(orgId))) {
    throw new SubscriptionRefused("card_required", "Add a card to start the plan.");
  }

  const periodEnd = nextPeriodEnd(now, now);
  let sub: Subscription;
  try {
    [sub] = await db
      .insert(subscriptions)
      .values({
        orgId,
        brandId,
        offerId,
        status: "past_due",
        createdAt: now,
        monthlyAmountCents,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        startedByUserId: params.userId && params.userId !== PLATFORM_USER_ID ? params.userId : null,
      })
      .returning();
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw taken();
    throw err;
  }
  const [charge] = await db
    .insert(subscriptionCharges)
    .values({
      subscriptionId: sub.id,
      orgId,
      periodStart: now,
      periodEnd,
      amountCents: monthlyAmountCents,
      status: "pending",
    })
    .returning();
  const result = await attemptCharge(sub, charge, now);
  if (result !== "paid") {
    await db
      .update(subscriptions)
      .set({ status: "canceled", endedAt: now, canceledAt: now, updatedAt: now })
      .where(eq(subscriptions.id, sub.id));
    if (result === "error") {
      throw new SubscriptionRefused(
        "charge_unavailable",
        "The card could not be charged right now, so the plan did not start. Try again in a moment.",
        502
      );
    }
    throw new SubscriptionRefused(
      "first_charge_declined",
      "The card was not charged, so the plan did not start. Try another card."
    );
  }
  const [active] = await db
    .update(subscriptions)
    .set({ status: "active", updatedAt: now })
    .where(eq(subscriptions.id, sub.id))
    .returning();
  await enterSubscriptionMode(orgId);
  console.log(
    `[billing-service] plan: org ${orgId} bought ${monthlyAmountCents} cents/month for brand ${brandId} x offer ${offerId}`
  );
  return active;
}

// --- the lifecycle ---------------------------------------------------------

/**
 * Expire what was not spent before `boundary`, once. The balance right now minus
 * any credit that arrived AT or after the boundary (a subscription charge for the
 * new period, a grant) is what is left of the old periods. Spend between the
 * boundary and this tick is counted as old credit spent first, which can only
 * expire less (bounded by one hourly tick of spend). Never below zero.
 */
async function expireAt(sub: Subscription, boundary: Date): Promise<void> {
  const [done] = await db
    .select({ id: subscriptionCreditExpiries.id })
    .from(subscriptionCreditExpiries)
    .where(
      and(
        eq(subscriptionCreditExpiries.subscriptionId, sub.id),
        eq(subscriptionCreditExpiries.boundaryAt, boundary)
      )
    )
    .limit(1);
  if (done) return;

  const snapshot = await computeBalance(sub.orgId);
  const [paidSince] = await db
    .select({ total: rawSql<string>`COALESCE(SUM(${subscriptionCharges.amountCents}), 0)::text` })
    .from(subscriptionCharges)
    .where(
      and(
        eq(subscriptionCharges.orgId, sub.orgId),
        eq(subscriptionCharges.status, "paid"),
        gte(subscriptionCharges.paidAt, boundary)
      )
    );
  const [grantedSince] = await db
    .select({ total: rawSql<string>`COALESCE(SUM(${localPromos.amountCents}), 0)::text` })
    .from(localPromos)
    .where(and(eq(localPromos.orgId, sub.orgId), gte(localPromos.createdAt, boundary)));
  const unspent =
    Number(snapshot.balanceCents) - Number(paidSince?.total ?? 0) - Number(grantedSince?.total ?? 0);
  // Several plans share ONE balance: a plan never expires more than the credit IT
  // brought for the period that is ending, so its boundary cannot eat another
  // plan's month. A lone plan is uncapped, exactly as before plans were per offer.
  const cap = await otherPlansLive(sub) ? await periodCreditCents(sub) : Number.POSITIVE_INFINITY;
  const amount = Math.max(0, Math.min(unspent, cap));

  await db
    .insert(subscriptionCreditExpiries)
    .values({
      orgId: sub.orgId,
      subscriptionId: sub.id,
      boundaryAt: boundary,
      amountCents: amount.toFixed(10),
    })
    .onConflictDoNothing({
      target: [subscriptionCreditExpiries.subscriptionId, subscriptionCreditExpiries.boundaryAt],
    });
  if (amount > 0) {
    console.log(
      `[billing-service] subscription: org ${sub.orgId} — ${amount.toFixed(2)} cents of unspent credit expired at ${boundary.toISOString()}`
    );
  }
}

/** Does the org hold a live plan other than this one? */
async function otherPlansLive(sub: Subscription): Promise<boolean> {
  const [row] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.orgId, sub.orgId),
        ne(subscriptions.status, "canceled"),
        ne(subscriptions.id, sub.id)
      )
    )
    .limit(1);
  return !!row;
}

/** The credit this plan brought for its current period: its paid charge, or the trial grant. */
async function periodCreditCents(sub: Subscription): Promise<number> {
  const charge = await getCharge(sub.id, sub.currentPeriodStart);
  if (charge?.status === "paid") return charge.amountCents;
  if (sub.trialStartedAt && sub.trialStartedAt.getTime() === sub.currentPeriodStart.getTime()) {
    return (await getSubscriptionTrialGrantCents(sub.orgId)) ?? 0;
  }
  return 0;
}

type AttemptResult = "paid" | "declined" | "permanent" | "error";

function upstreamStatus(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/stripe-service .* failed: (\d{3})/);
  return m ? Number(m[1]) : null;
}

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`subscription charge timeout after ${ms}ms`)), ms);
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

/**
 * One attempt at a period's charge. Keyed per (charge, attempt) so a retried
 * request collapses onto the same acquirer charge while a later rung is a new one.
 * A refusal consumes a rung; an outage (no answer) does not.
 */
async function attemptCharge(
  sub: Subscription,
  charge: SubscriptionCharge,
  now: Date
): Promise<AttemptResult> {
  const attempt = charge.attemptCount + 1;
  let declinedCode: string | null = null;
  let reference: string | null = null;
  try {
    const outcome = await withTimeout(
      CHARGE_TIMEOUT_MS,
      reloadOffSession(sub.orgId, charge.amountCents, `subscription:${charge.id}:${attempt}`, {
        reason: "subscription",
        subscription_id: sub.id,
        period_start: charge.periodStart.toISOString(),
      })
    );
    if (outcome.status === "succeeded") {
      await db
        .update(subscriptionCharges)
        .set({
          status: "paid",
          attemptCount: attempt,
          lastAttemptAt: now,
          paidAt: now,
          reference: outcome.reference ?? null,
          failureCode: null,
        })
        .where(eq(subscriptionCharges.id, charge.id));
      return "paid";
    }
    declinedCode = outcome.failure_code ?? "declined";
    reference = outcome.reference ?? null;
  } catch (err) {
    const status = upstreamStatus(err);
    if (status === 402 || status === 404 || status === 409) {
      declinedCode = `http_${status}`;
    } else {
      console.error(
        `[billing-service] subscription charge for org ${sub.orgId} could not be attempted (retried next tick):`,
        err
      );
      await db
        .update(subscriptionCharges)
        .set({ lastAttemptAt: now })
        .where(eq(subscriptionCharges.id, charge.id));
      return "error";
    }
  }
  await db
    .update(subscriptionCharges)
    .set({
      status: "failed",
      attemptCount: attempt,
      lastAttemptAt: now,
      firstFailedAt: charge.firstFailedAt ?? now,
      reference,
      failureCode: declinedCode,
    })
    .where(eq(subscriptionCharges.id, charge.id));
  console.warn(
    `[billing-service] subscription charge refused for org ${sub.orgId} (attempt ${attempt}, ${declinedCode})`
  );
  return isPermanentDecline(declinedCode) ? "permanent" : "declined";
}

async function endSubscription(sub: Subscription, at: Date, now: Date): Promise<Subscription> {
  await expireAt(sub, at);
  const [ended] = await db
    .update(subscriptions)
    .set({ status: "canceled", endedAt: at, canceledAt: sub.canceledAt ?? now, updatedAt: now })
    .where(eq(subscriptions.id, sub.id))
    .returning();
  console.log(`[billing-service] subscription: org ${sub.orgId} ended at ${at.toISOString()}`);
  return ended;
}

/** Charge a period and move the subscription onto it (paid → active, refused → past_due). */
async function billPeriod(sub: Subscription, periodStart: Date, now: Date): Promise<Subscription> {
  const anchor = renewalAnchor(sub);
  const periodEnd = nextPeriodEnd(periodStart, anchor);
  let charge = await getCharge(sub.id, periodStart);
  if (!charge) {
    await db
      .insert(subscriptionCharges)
      .values({
        subscriptionId: sub.id,
        orgId: sub.orgId,
        periodStart,
        periodEnd,
        amountCents: sub.monthlyAmountCents,
        status: "pending",
      })
      .onConflictDoNothing({
        target: [subscriptionCharges.subscriptionId, subscriptionCharges.periodStart],
      });
    charge = await getCharge(sub.id, periodStart);
  }
  if (!charge) throw new Error(`[billing-service] no charge row for subscription ${sub.id}`);

  const result = charge.status === "paid" ? "paid" : await attemptCharge(sub, charge, now);
  if (result === "error") return sub; // nothing moves; the next tick retries
  if (result === "permanent") return endSubscription(sub, periodStart, now);
  const [updated] = await db
    .update(subscriptions)
    .set({
      status: result === "paid" ? "active" : "past_due",
      currentPeriodStart: periodStart,
      currentPeriodEnd: charge.periodEnd,
      updatedAt: now,
    })
    .where(eq(subscriptions.id, sub.id))
    .returning();
  return updated;
}

/** A past_due subscription: the next rung of its period's charge, or the end. */
async function retryPastDue(sub: Subscription, now: Date): Promise<Subscription> {
  const charge = await getCharge(sub.id, sub.currentPeriodStart);
  if (!charge) throw new Error(`[billing-service] past_due subscription ${sub.id} has no charge row`);
  if (charge.status !== "failed") return billPeriod(sub, sub.currentPeriodStart, now);
  if (charge.attemptCount >= MAX_ATTEMPTS_PER_STREAK || !charge.firstFailedAt) {
    return endSubscription(sub, now, now);
  }
  const due = nextRetryDueAt(charge.attemptCount, charge.firstFailedAt);
  if (due === null) return endSubscription(sub, now, now);
  if (now < due) return sub;
  return billPeriod(sub, sub.currentPeriodStart, now);
}

/**
 * Bring one subscription up to `now`: expire at each passed boundary, then end it
 * (cancel pending) or bill the next period; retry a past_due charge on its rungs.
 */
export async function advanceSubscription(sub: Subscription, now: Date = new Date()): Promise<Subscription> {
  let current = sub;
  for (let i = 0; i < MAX_BOUNDARIES_PER_TICK; i += 1) {
    if (current.status === "canceled") return current;
    if (current.status === "past_due") return retryPastDue(current, now);
    if (now < current.currentPeriodEnd) return current;

    const boundary = current.currentPeriodEnd;
    if (current.cancelAtPeriodEnd) return endSubscription(current, boundary, now);
    await expireAt(current, boundary);
    const next = await billPeriod(current, boundary, now);
    if (next === current || next.status !== "active") return next;
    current = next;
  }
  return current;
}

export interface SubscriptionSettlement {
  subscription: Subscription | null;
  trialGrantCents: number | null;
}

/**
 * Apply what the org's state means, idempotently: a stamped checkout whose card is
 * now on file starts the subscription; an abandoned one is forgotten; a live
 * subscription is advanced to now. Fails loud when stripe-service cannot be asked.
 */
export async function settleOrgSubscription(
  orgId: string,
  now: Date = new Date()
): Promise<SubscriptionSettlement> {
  let live = await getLiveSubscription(orgId);
  if (!live) {
    const [account] = await db
      .select({ stampedAt: billingAccounts.subscriptionCheckoutStartedAt })
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);
    if (account?.stampedAt) {
      if (await confirmChargeableCard(orgId)) {
        try {
          live = await startSubscription({ orgId, userId: null, now });
        } catch (err) {
          if (!(err instanceof SubscriptionRefused)) throw err;
          console.warn(`[billing-service] subscription auto-start refused for org ${orgId}: ${err.code}`);
        }
      } else if (now.getTime() - account.stampedAt.getTime() > ABANDONED_CHECKOUT_MS) {
        await db
          .update(billingAccounts)
          .set({ subscriptionCheckoutStartedAt: null, subscriptionRequestedAmountCents: null })
          .where(eq(billingAccounts.orgId, orgId));
      }
    }
  }
  let subscription: Subscription | null = null;
  if (live) {
    for (const plan of await listLiveSubscriptions(orgId)) {
      const advanced = await advanceSubscription(plan, now);
      if (plan.id === live.id) subscription = advanced;
    }
  } else {
    subscription = await getLatestSubscription(orgId);
  }
  return { subscription, trialGrantCents: await getSubscriptionTrialGrantCents(orgId) };
}

/**
 * Hourly: every stamped checkout and every subscription that has not ended.
 * Bounded by those two sets. Per-org failures are isolated and logged.
 */
export async function runSubscriptionSweep(
  now: Date = new Date(),
  afterSettle?: (orgId: string, sub: Subscription | null) => Promise<void>
): Promise<{ checked: number; failed: number }> {
  const stamped = await db
    .select({ orgId: billingAccounts.orgId })
    .from(billingAccounts)
    .where(isNotNull(billingAccounts.subscriptionCheckoutStartedAt));
  const live = await db
    .select({ orgId: subscriptions.orgId })
    .from(subscriptions)
    .where(ne(subscriptions.status, "canceled"));
  const orgIds = [...new Set([...stamped, ...live].map((r) => r.orgId))];
  const out = { checked: 0, failed: 0 };
  for (const orgId of orgIds) {
    out.checked += 1;
    try {
      const { subscription } = await settleOrgSubscription(orgId, now);
      if (afterSettle) await afterSettle(orgId, subscription);
    } catch (err) {
      out.failed += 1;
      console.error(`[billing-service] subscription sweep failed for org ${orgId}:`, err);
    }
  }
  return out;
}

// --- customer actions ------------------------------------------------------

async function requireLive(orgId: string, now: Date, subscriptionId?: string): Promise<Subscription> {
  const live = subscriptionId
    ? (await listLiveSubscriptions(orgId)).find((s) => s.id === subscriptionId) ?? null
    : await getLiveSubscription(orgId);
  if (!live) throw new SubscriptionRefused("no_subscription", "This organization has no subscription.", 404);
  const advanced = await advanceSubscription(live, now);
  if (advanced.status === "canceled") {
    throw new SubscriptionRefused("no_subscription", "This organization has no subscription.", 404);
  }
  return advanced;
}

/** Change the monthly amount (any ladder value, up or down) from the next charge. */
export async function changeSubscriptionAmount(
  orgId: string,
  monthlyAmountCents: number,
  now: Date = new Date(),
  subscriptionId?: string
): Promise<Subscription> {
  const sub = await requireLive(orgId, now, subscriptionId);
  if (sub.status === "trialing") {
    throw new SubscriptionRefused(
      "subscription_trialing",
      "The plan can be changed once the free trial has ended."
    );
  }
  if (sub.status !== "active") {
    throw new SubscriptionRefused(
      "subscription_not_active",
      "The last payment did not go through; the plan can be changed once it has."
    );
  }
  if (sub.cancelAtPeriodEnd) {
    throw new SubscriptionRefused(
      "subscription_cancel_pending",
      "The subscription is set to end; resume it before changing the plan."
    );
  }
  if (monthlyAmountCents === sub.monthlyAmountCents) {
    throw new SubscriptionRefused("amount_unchanged", "That is already the current plan.");
  }
  const [updated] = await db
    .update(subscriptions)
    .set({ monthlyAmountCents, updatedAt: now })
    .where(eq(subscriptions.id, sub.id))
    .returning();
  return updated;
}

/**
 * Cancel: no further charge. Trialing / active → ends at the period end (undoable
 * until then). past_due → ends now (its pending retries ARE the future charges).
 */
export async function cancelSubscription(
  orgId: string,
  now: Date = new Date(),
  subscriptionId?: string
): Promise<Subscription> {
  const sub = await requireLive(orgId, now, subscriptionId);
  if (sub.status === "past_due") {
    const [flagged] = await db
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: true, canceledAt: now, updatedAt: now })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    return endSubscription(flagged, now, now);
  }
  if (sub.cancelAtPeriodEnd) return sub;
  const [updated] = await db
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: true, canceledAt: now, updatedAt: now })
    .where(eq(subscriptions.id, sub.id))
    .returning();
  return updated;
}

/** Undo a pending cancel. */
export async function resumeSubscription(
  orgId: string,
  now: Date = new Date(),
  subscriptionId?: string
): Promise<Subscription> {
  const sub = await requireLive(orgId, now, subscriptionId);
  if (!sub.cancelAtPeriodEnd) {
    throw new SubscriptionRefused("subscription_not_cancel_pending", "The subscription is not set to end.");
  }
  const [updated] = await db
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: false, canceledAt: null, updatedAt: now })
    .where(eq(subscriptions.id, sub.id))
    .returning();
  return updated;
}

// --- wire --------------------------------------------------------------------

/** When billing will next charge: trial end / period end; never once ending or ended. */
export function nextChargeAt(sub: Subscription): Date | null {
  if (sub.status === "canceled" || sub.cancelAtPeriodEnd) return null;
  return sub.currentPeriodEnd;
}

/** The wire view of a subscription, shared by every route. */
export function subscriptionWire(sub: Subscription | null, hasPaymentMethod: boolean | null) {
  if (!sub) return null;
  const canChange = sub.status === "active" && !sub.cancelAtPeriodEnd;
  const next = nextChargeAt(sub);
  return {
    id: sub.id,
    brand_id: sub.brandId,
    offer_id: sub.offerId,
    status: sub.status,
    trial_end: sub.trialEndsAt ? sub.trialEndsAt.toISOString() : null,
    cancel_at_period_end: sub.cancelAtPeriodEnd,
    current_period_start: sub.currentPeriodStart.toISOString(),
    current_period_end: sub.currentPeriodEnd.toISOString(),
    next_charge_at: next ? next.toISOString() : null,
    ended_at: sub.endedAt ? sub.endedAt.toISOString() : null,
    monthly_amount_cents: sub.monthlyAmountCents,
    currency: "usd",
    has_payment_method: hasPaymentMethod,
    can_change_amount: canChange,
    /** Kept for consumers written against the first (+$100) shape; = can_change_amount. */
    can_raise: canChange,
    next_raise_monthly_amount_cents: canChange ? sub.monthlyAmountCents + SUBSCRIPTION_STEP_CENTS : null,
  };
}
