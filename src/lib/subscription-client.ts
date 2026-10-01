/**
 * stripe-service's subscription surface (v0.56.0), as billing reads it. The ONLY
 * place that knows the wire shape; lib/subscription works on `OrgSubscription`.
 *
 * Stripe owns subscription state, so nothing here is stored: every read is live.
 * All routes are `/internal/subscriptions/by-org/{orgId}…`: X-API-Key + the org in
 * the path, no end user (an optional `x-user-id` names the payer on checkout).
 *
 * "No subscription" is a 200 with `has_subscription: false`; anything we could not
 * ask (502 / 503) THROWS — never an empty list.
 */

import { fetchWithRetry } from "./fetch-retry.js";

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

/** A refusal stripe-service stated with a code (403 / 404 / 409). */
export class SubscriptionServiceError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "SubscriptionServiceError";
    this.status = status;
    this.code = code;
  }
}

/** The wire summary stripe-service answers for one subscription. */
interface SubscriptionSummaryWire {
  id: string;
  status: string;
  amount: number;
  currency: string;
  trial_end: number | null;
  current_period_end: number | null;
  cancel_at_period_end: boolean;
  has_payment_method: boolean;
  created: number;
}

function iso(unixSeconds: number | null): string | null {
  return unixSeconds == null ? null : new Date(unixSeconds * 1000).toISOString();
}

export function toOrgSubscription(w: SubscriptionSummaryWire): OrgSubscription {
  if (typeof w.id !== "string" || typeof w.status !== "string" || typeof w.amount !== "number") {
    throw new Error(`[billing-service] malformed subscription summary from stripe-service: ${JSON.stringify(w)}`);
  }
  return {
    id: w.id,
    status: w.status,
    trialEnd: iso(w.trial_end),
    cancelAtPeriodEnd: w.cancel_at_period_end === true,
    currentPeriodEnd: iso(w.current_period_end),
    monthlyAmountCents: w.amount,
    currency: w.currency,
    hasPaymentMethod: w.has_payment_method === true,
    createdAt: new Date(w.created * 1000).toISOString(),
  };
}

function config() {
  const url = process.env.STRIPE_SERVICE_URL;
  const apiKey = process.env.STRIPE_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("STRIPE_SERVICE_URL and STRIPE_SERVICE_API_KEY must be configured");
  }
  return { url, apiKey };
}

async function callSubscriptions<T>(
  method: "GET" | "POST" | "DELETE",
  orgId: string,
  suffix: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<T> {
  const { url, apiKey } = config();
  const path = `/internal/subscriptions/by-org/${encodeURIComponent(orgId)}${suffix}`;
  const res = await fetchWithRetry(`${url}${path}`, {
    method,
    headers: { "x-api-key": apiKey, "content-type": "application/json", ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    let code: string | null = null;
    try {
      const parsed = JSON.parse(text) as { code?: unknown };
      code = typeof parsed.code === "string" ? parsed.code : null;
    } catch {
      code = null;
    }
    const message = `stripe-service ${method} ${path} failed: ${res.status} ${text}`;
    if (res.status === 403 || res.status === 404 || res.status === 409) {
      throw new SubscriptionServiceError(res.status, code, message);
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export async function fetchOrgSubscriptions(orgId: string): Promise<OrgSubscription[]> {
  const out = await callSubscriptions<{ has_subscription?: boolean; data?: SubscriptionSummaryWire[] }>(
    "GET",
    orgId,
    ""
  );
  if (!Array.isArray(out.data)) {
    throw new Error(`[billing-service] stripe-service subscription read for org ${orgId} carried no data list`);
  }
  return out.data.map(toOrgSubscription);
}

export interface SubscriptionCheckoutParams {
  monthlyAmountCents: number;
  /** Free trial length in days; null = no trial (the org already had one). */
  trialDays: number | null;
  uiMode: "embedded" | "hosted";
  successUrl?: string;
  cancelUrl?: string;
  /** The person subscribing (their email becomes the customer's once paid). */
  userId?: string;
}

export interface SubscriptionCheckoutSession {
  sessionId: string;
  /** Hosted: where to send the customer. */
  url: string | null;
  /** Embedded: mount with Stripe's initEmbeddedCheckout. */
  clientSecret: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORM_SENTINEL = "00000000-0000-0000-0000-000000000000";

export async function createSubscriptionCheckout(
  orgId: string,
  params: SubscriptionCheckoutParams
): Promise<SubscriptionCheckoutSession> {
  const body: Record<string, unknown> = {
    amount: params.monthlyAmountCents,
    currency: "usd",
    ui_mode: params.uiMode,
    product_name: "Distribute subscription",
    metadata: { org_id: orgId, purpose: "subscription" },
  };
  if (params.trialDays !== null) body.trial_period_days = params.trialDays;
  if (params.uiMode === "hosted") {
    body.success_url = params.successUrl;
    body.cancel_url = params.cancelUrl;
  }
  const person: Record<string, string> =
    params.userId && UUID_RE.test(params.userId) && params.userId !== PLATFORM_SENTINEL
      ? { "x-user-id": params.userId }
      : {};
  const session = await callSubscriptions<{ id?: string; url?: string | null; client_secret?: string | null }>(
    "POST",
    orgId,
    "/checkout",
    body,
    person
  );
  if (typeof session.id !== "string") {
    throw new Error(`[billing-service] stripe-service subscription checkout for org ${orgId} returned no session id`);
  }
  const url = session.url ?? null;
  const clientSecret = session.client_secret ?? null;
  if (params.uiMode === "hosted" ? !url : !clientSecret) {
    throw new Error(
      `[billing-service] stripe-service ${params.uiMode} subscription checkout for org ${orgId} returned no ${params.uiMode === "hosted" ? "url" : "client_secret"}`
    );
  }
  return { sessionId: session.id, url, clientSecret };
}

export async function updateSubscriptionMonthlyAmount(
  orgId: string,
  subscriptionId: string,
  monthlyAmountCents: number
): Promise<OrgSubscription> {
  const out = await callSubscriptions<SubscriptionSummaryWire>(
    "POST",
    orgId,
    `/${encodeURIComponent(subscriptionId)}/amount`,
    { amount: monthlyAmountCents },
    { "idempotency-key": `subscription-amount:${subscriptionId}:${monthlyAmountCents}` }
  );
  return toOrgSubscription(out);
}

export async function setSubscriptionCancelAtPeriodEnd(
  orgId: string,
  subscriptionId: string,
  cancelAtPeriodEnd: boolean
): Promise<OrgSubscription> {
  const out = await callSubscriptions<SubscriptionSummaryWire>(
    cancelAtPeriodEnd ? "POST" : "DELETE",
    orgId,
    `/${encodeURIComponent(subscriptionId)}/cancellation`
  );
  return toOrgSubscription(out);
}
