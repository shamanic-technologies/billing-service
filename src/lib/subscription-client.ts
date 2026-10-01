/**
 * stripe-service's subscription surface, as billing reads it. The ONLY place that
 * knows the wire shape; lib/subscription works on `OrgSubscription`.
 *
 * Stripe owns subscription state, so nothing here is stored: every read is live.
 */

export interface OrgSubscription {
  id: string;
  /** Stripe's status: trialing | active | past_due | canceled | unpaid | incomplete | incomplete_expired | paused */
  status: string;
  /** ISO instant the trial ends; null when the subscription never had a trial. */
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** ISO instant the current period ends (the next invoice while active). */
  currentPeriodEnd: string | null;
  /** What the next invoice charges, in minor units. */
  monthlyAmountCents: number;
  currency: string;
  /** Whether a payment method is set to charge the invoices. */
  hasPaymentMethod: boolean;
  /** ISO instant the subscription was created. */
  createdAt: string;
}

export async function fetchOrgSubscriptions(_orgId: string): Promise<OrgSubscription[]> {
  throw new Error("[billing-service] stripe-service subscription read not wired yet");
}

export interface SubscriptionCheckoutParams {
  /** The org's Stripe customer (the org pays through Stripe; checked by the caller). */
  customerId: string;
  monthlyAmountCents: number;
  /** Free trial length in days; null = no trial (the org already had one). */
  trialDays: number | null;
  uiMode: "embedded" | "hosted";
  successUrl?: string;
  cancelUrl?: string;
}

export interface SubscriptionCheckoutSession {
  sessionId: string;
  /** Hosted: where to send the customer. */
  url: string | null;
  /** Embedded: mount with Stripe's initEmbeddedCheckout. */
  clientSecret: string | null;
}

export async function createSubscriptionCheckout(
  _identity: Record<string, string>,
  _params: SubscriptionCheckoutParams
): Promise<SubscriptionCheckoutSession> {
  throw new Error("[billing-service] stripe-service subscription checkout not wired yet");
}

export async function updateSubscriptionMonthlyAmount(
  _orgId: string,
  _subscriptionId: string,
  _monthlyAmountCents: number
): Promise<OrgSubscription> {
  throw new Error("[billing-service] stripe-service subscription update not wired yet");
}

export async function setSubscriptionCancelAtPeriodEnd(
  _orgId: string,
  _subscriptionId: string,
  _cancelAtPeriodEnd: boolean
): Promise<OrgSubscription> {
  throw new Error("[billing-service] stripe-service subscription cancel not wired yet");
}
