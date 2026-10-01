/**
 * SUBSCRIPTION — the third payment mode (migration 0055). Owner's model, verbatim
 * in substance:
 *
 *  - Signup: card MANDATORY, 3-day free trial, then $99/month charged by Stripe.
 *  - PREPAID in nature: money paid = credits. Each PAID monthly invoice is that
 *    amount of credit. Nothing here grants it: a paid invoice is an ordinary
 *    succeeded payment on the org's Stripe customer, which stripe-service already
 *    counts in the org's payment totals (net of refunds), and `credited` is built
 *    from those. So an invoice is credited exactly once, keyed by the payment
 *    itself — a webhook replay cannot count it twice, and nothing here can either.
 *  - At TRIAL START the org's free credit is topped up to $99 (the
 *    `subscription_trial` ledger key), at our expense even if it cancels during the
 *    trial. "Topped up TO" rather than "plus": an org that already holds its $30
 *    welcome (or an anonymous trial seed) gets the difference, so its free credit is
 *    $99 in total — never $99 on top of another gift.
 *  - When credit runs out, sending stops. No auto-reload, no credit line, floor 0
 *    (lib/topup-tier, lib/payment-outlook, lib/month-end-sweep all read the mode).
 *  - Once ACTIVE (not trialing) the monthly amount can be raised in +$100 steps
 *    ($99 → $199 → $299 …), for the NEXT invoice (no proration).
 *  - Cancel = stop future charges at period end (undoable until then). Nothing
 *    else is cut.
 *
 * WHO STATES WHAT. Stripe state (status, trial end, period end, amount) belongs to
 * stripe-service and is read live, never copied here. Billing owns only the mode,
 * the trial grant and the rules about who may do what.
 *
 * WHEN THE MODE FLIPS. Opening a subscription checkout stamps
 * `subscription_checkout_started_at`. The first read that OBSERVES a live
 * subscription for a stamped org (the subscription read the dashboard makes when the
 * checkout completes, or the hourly settle) enters subscription mode, disarms auto
 * top-up, grants the trial credit and clears the stamp. An abandoned checkout is
 * forgotten after `ABANDONED_CHECKOUT_MS`. Nothing about an org that never opens a
 * subscription checkout changes.
 */

import { and, eq, isNotNull, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  PLATFORM_USER_ID,
  SUBSCRIPTION_TRIAL_CODE,
} from "../db/schema.js";
import { GrantPromoCodeMissingError, sumLocalPromoCreditsForOrg } from "./promos.js";
import { asPaymentMode, type PaymentMode } from "./payment-mode-types.js";
import {
  createSubscriptionCheckout,
  fetchOrgSubscriptions,
  setSubscriptionCancelAtPeriodEnd,
  updateSubscriptionMonthlyAmount,
  type OrgSubscription,
  type SubscriptionCheckoutSession,
} from "./subscription-client.js";
import {
  getOrgAcquirer,
  LEGACY_PM_GATE_ACQUIRER,
  sumSucceededTopupsForOrg,
} from "./stripe-service-client.js";
import { ensureOrgStripeCustomer } from "./account.js";

/** $99/month: what a new subscription costs. */
export const SUBSCRIPTION_BASE_MONTHLY_CENTS = 9900;
/** The monthly amount moves in +$100 steps: $99, $199, $299, … */
export const SUBSCRIPTION_STEP_CENTS = 10000;
/** Free trial before the first invoice. */
export const SUBSCRIPTION_TRIAL_DAYS = 3;
/** A checkout nobody completed is forgotten after this (Stripe sessions expire at 24h). */
export const ABANDONED_CHECKOUT_MS = 48 * 60 * 60 * 1000;

/** Statuses under which the subscription still exists and will (or may) be invoiced. */
const LIVE_STATUSES = new Set(["trialing", "active", "past_due", "unpaid", "incomplete", "paused"]);

export function isLiveSubscription(sub: OrgSubscription): boolean {
  return LIVE_STATUSES.has(sub.status);
}

/** A monthly amount the ladder allows: $99 + k × $100, k ≥ 0. */
export function isValidMonthlyAmount(cents: number): boolean {
  return (
    Number.isInteger(cents) &&
    cents >= SUBSCRIPTION_BASE_MONTHLY_CENTS &&
    (cents - SUBSCRIPTION_BASE_MONTHLY_CENTS) % SUBSCRIPTION_STEP_CENTS === 0
  );
}

/**
 * The subscription that describes the org now: the newest LIVE one, else the newest
 * of any status (so an ended subscription still reads as ended), else null.
 */
export function pickCurrentSubscription(subs: OrgSubscription[]): OrgSubscription | null {
  const byNewest = [...subs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return byNewest.find(isLiveSubscription) ?? byNewest[0] ?? null;
}

/**
 * When Stripe will next try to charge: the trial end while trialing, the period end
 * while active, never once a cancel is pending or the subscription ended.
 */
export function nextChargeAt(sub: OrgSubscription): string | null {
  if (!isLiveSubscription(sub) || sub.cancelAtPeriodEnd) return null;
  if (sub.status === "trialing") return sub.trialEnd;
  return sub.currentPeriodEnd;
}

/** Why a subscription action was refused. Stable codes a caller branches on. */
export type SubscriptionRefusalCode =
  | "subscription_exists"
  | "existing_paying_org"
  | "acquirer_not_supported"
  | "no_subscription"
  | "subscription_trialing"
  | "subscription_not_active"
  | "subscription_cancel_pending"
  | "subscription_not_cancel_pending"
  | "amount_not_higher";

export class SubscriptionRefused extends Error {
  readonly code: SubscriptionRefusalCode;
  readonly status: 404 | 409;
  constructor(code: SubscriptionRefusalCode, message: string, status: 404 | 409 = 409) {
    super(message);
    this.name = "SubscriptionRefused";
    this.code = code;
    this.status = status;
  }
}

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
 * Top the org's free credit up to the trial amount, ONCE per org.
 *
 * Amount = max(0, trial amount − every credit already granted to the org), so the
 * org's free credit at trial start is the trial amount in total. A row is written
 * even when that difference is 0: it is the marker that the org had its trial, and
 * the partial unique (org, promo_code) index makes a replay a no-op.
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

/** Enter subscription mode: set the mode, disarm auto top-up, clear the checkout stamp. */
async function enterSubscriptionMode(orgId: string): Promise<void> {
  await db
    .update(billingAccounts)
    .set({
      paymentMode: "subscription",
      topupAmountCents: null,
      topupThresholdCents: null,
      subscriptionCheckoutStartedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(billingAccounts.orgId, orgId));
}

export interface SubscriptionSettlement {
  paymentMode: PaymentMode | null;
  subscription: OrgSubscription | null;
  trialGrantCents: number | null;
}

/**
 * Read the org's subscription and apply what it means, idempotently:
 *  - a live subscription on an org that opened a subscription checkout → enter
 *    subscription mode;
 *  - a live subscription that carries a trial, on an org in subscription mode →
 *    the one-shot trial grant;
 *  - a stamped checkout with nothing live after ABANDONED_CHECKOUT_MS → forget it.
 *
 * The mode only ever flips on a STAMPED org, so a staff decision to move an org out
 * of subscription is never overturned by a later read. Fails loud when
 * stripe-service cannot be asked.
 */
export async function settleOrgSubscription(
  orgId: string,
  now: Date = new Date()
): Promise<SubscriptionSettlement> {
  const subs = await fetchOrgSubscriptions(orgId);
  const current = pickCurrentSubscription(subs);

  const [account] = await db
    .select({
      paymentMode: billingAccounts.paymentMode,
      stampedAt: billingAccounts.subscriptionCheckoutStartedAt,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  if (!account) {
    return { paymentMode: null, subscription: current, trialGrantCents: null };
  }

  let mode = asPaymentMode(account.paymentMode);
  const live = current !== null && isLiveSubscription(current);

  if (live && account.stampedAt !== null) {
    await enterSubscriptionMode(orgId);
    mode = "subscription";
    console.log(
      `[billing-service] subscription: org ${orgId} entered subscription mode (${current.id}, ${current.status})`
    );
  } else if (
    !live &&
    account.stampedAt !== null &&
    now.getTime() - account.stampedAt.getTime() > ABANDONED_CHECKOUT_MS
  ) {
    await db
      .update(billingAccounts)
      .set({ subscriptionCheckoutStartedAt: null })
      .where(eq(billingAccounts.orgId, orgId));
  }

  let trialGrantCents = await getSubscriptionTrialGrantCents(orgId);
  if (live && mode === "subscription" && current.trialEnd !== null && trialGrantCents === null) {
    trialGrantCents = (await grantSubscriptionTrial(orgId)).grantedCents;
  }

  return { paymentMode: mode, subscription: current, trialGrantCents };
}

/**
 * Hourly: settle every org with an open subscription checkout, so the mode and the
 * trial grant land even if the dashboard never reads again. Bounded by the stamp
 * (cleared once settled or abandoned). Per-org failures are isolated and logged.
 */
export async function runSubscriptionSettleSweep(
  now: Date = new Date()
): Promise<{ checked: number; entered: number; failed: number }> {
  const stamped = await db
    .select({ orgId: billingAccounts.orgId })
    .from(billingAccounts)
    .where(isNotNull(billingAccounts.subscriptionCheckoutStartedAt));
  const out = { checked: 0, entered: 0, failed: 0 };
  for (const { orgId } of stamped) {
    out.checked += 1;
    try {
      const s = await settleOrgSubscription(orgId, now);
      if (s.paymentMode === "subscription") out.entered += 1;
    } catch (err) {
      out.failed += 1;
      console.error(`[billing-service] subscription settle failed for org ${orgId}:`, err);
    }
  }
  return out;
}

/** May this org start a trial? Once per org: never after a trial grant or a past trial. */
export function trialAllowed(subs: OrgSubscription[], trialGrantCents: number | null): boolean {
  return trialGrantCents === null && !subs.some((s) => s.trialEnd !== null);
}

/** Stamp the org as having opened a subscription checkout (see the header). */
export async function stampSubscriptionCheckout(orgId: string, now: Date = new Date()): Promise<void> {
  await db
    .update(billingAccounts)
    .set({ subscriptionCheckoutStartedAt: now })
    .where(eq(billingAccounts.orgId, orgId));
}

// --- Customer actions -------------------------------------------------------

/**
 * Open a subscription checkout ($99/month, card required, 3-day trial once per org).
 *
 * Refused (409) when the org already has a live subscription, when it pays through
 * an acquirer that has no subscription object, and when it is an EXISTING paying org
 * not in subscription mode: existing orgs keep their mode, only staff moves them.
 */
export async function startSubscriptionCheckout(params: {
  orgId: string;
  identity: Record<string, string>;
  uiMode: "embedded" | "hosted";
  successUrl?: string;
  cancelUrl?: string;
  now?: Date;
}): Promise<SubscriptionCheckoutSession & { trialDays: number | null; monthlyAmountCents: number }> {
  const { orgId } = params;
  const subs = await fetchOrgSubscriptions(orgId);
  const live = subs.find(isLiveSubscription);
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
        "This organization already pays as " +
          `${account.paymentMode}; moving it to a subscription is done by our team.`
      );
    }
  }

  const acquirer = await getOrgAcquirer(orgId);
  if (acquirer !== LEGACY_PM_GATE_ACQUIRER) {
    throw new SubscriptionRefused(
      "acquirer_not_supported",
      "This organization pays through a processor that does not support subscriptions."
    );
  }
  const customer = await ensureOrgStripeCustomer(params.identity);
  if (!customer) {
    // ensureOrgStripeCustomer answers null only for a non-Stripe acquirer, refused above.
    throw new Error(`[billing-service] no Stripe customer for Stripe org ${orgId}`);
  }

  const trialDays = trialAllowed(subs, await getSubscriptionTrialGrantCents(orgId))
    ? SUBSCRIPTION_TRIAL_DAYS
    : null;
  await stampSubscriptionCheckout(orgId, params.now);
  const session = await createSubscriptionCheckout(params.identity, {
    customerId: customer.id,
    monthlyAmountCents: SUBSCRIPTION_BASE_MONTHLY_CENTS,
    trialDays,
    uiMode: params.uiMode,
    successUrl: params.successUrl,
    cancelUrl: params.cancelUrl,
  });
  return { ...session, trialDays, monthlyAmountCents: SUBSCRIPTION_BASE_MONTHLY_CENTS };
}

async function requireCurrentLive(orgId: string): Promise<OrgSubscription> {
  const current = pickCurrentSubscription(await fetchOrgSubscriptions(orgId));
  if (!current || !isLiveSubscription(current)) {
    throw new SubscriptionRefused("no_subscription", "This organization has no subscription.", 404);
  }
  return current;
}

/**
 * Raise the monthly amount for the NEXT invoice (no proration). Active
 * subscriptions only: refused while trialing, with a cancel pending, or when the
 * amount is not higher. The amount must be on the ladder (validated by the caller).
 */
export async function raiseSubscriptionAmount(
  orgId: string,
  monthlyAmountCents: number
): Promise<OrgSubscription> {
  const current = await requireCurrentLive(orgId);
  if (current.status === "trialing") {
    throw new SubscriptionRefused(
      "subscription_trialing",
      "The monthly amount can be raised once the free trial has ended."
    );
  }
  if (current.status !== "active") {
    throw new SubscriptionRefused(
      "subscription_not_active",
      `The subscription is ${current.status}; the monthly amount can only be raised while it is active.`
    );
  }
  if (current.cancelAtPeriodEnd) {
    throw new SubscriptionRefused(
      "subscription_cancel_pending",
      "The subscription is set to cancel; resume it before raising the monthly amount."
    );
  }
  if (monthlyAmountCents <= current.monthlyAmountCents) {
    throw new SubscriptionRefused(
      "amount_not_higher",
      `The new monthly amount must be higher than the current ${current.monthlyAmountCents} cents.`
    );
  }
  return updateSubscriptionMonthlyAmount(orgId, current.id, monthlyAmountCents);
}

/** Cancel at period end: no further invoice. Idempotent. */
export async function cancelSubscription(orgId: string): Promise<OrgSubscription> {
  const current = await requireCurrentLive(orgId);
  if (current.cancelAtPeriodEnd) return current;
  return setSubscriptionCancelAtPeriodEnd(orgId, current.id, true);
}

/** Undo a pending cancel. Refused when nothing is pending. */
export async function resumeSubscription(orgId: string): Promise<OrgSubscription> {
  const current = await requireCurrentLive(orgId);
  if (!current.cancelAtPeriodEnd) {
    throw new SubscriptionRefused(
      "subscription_not_cancel_pending",
      "The subscription is not set to cancel."
    );
  }
  return setSubscriptionCancelAtPeriodEnd(orgId, current.id, false);
}

/** The wire view of a subscription, shared by every route. */
export function subscriptionWire(sub: OrgSubscription | null) {
  if (!sub) return null;
  const canRaise =
    sub.status === "active" && !sub.cancelAtPeriodEnd;
  return {
    id: sub.id,
    status: sub.status,
    trial_end: sub.trialEnd,
    cancel_at_period_end: sub.cancelAtPeriodEnd,
    current_period_end: sub.currentPeriodEnd,
    next_charge_at: nextChargeAt(sub),
    monthly_amount_cents: sub.monthlyAmountCents,
    currency: sub.currency,
    has_payment_method: sub.hasPaymentMethod,
    can_raise: canRaise,
    next_raise_monthly_amount_cents: canRaise ? sub.monthlyAmountCents + SUBSCRIPTION_STEP_CENTS : null,
  };
}
