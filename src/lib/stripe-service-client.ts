/**
 * HTTP client for stripe-service.
 *
 * Stripe-service wraps all Stripe SDK calls + webhook handling. Billing-service
 * never touches Stripe directly post-#0016.
 *
 * Endpoint surface mirrors Stripe verbatim where possible. Composite operations
 * (balance/PM checks, reloads, brand transfers) live billing-side and call
 * Stripe-shape primitives — stripe-service refuses to add billing-only shortcuts.
 */

import { Decimal } from "decimal.js";

export type IdentityHeaders = Record<string, string>;

// --- Stripe-shape types ---

export interface StripeCustomer {
  id: string;
  object: "customer";
  metadata: Record<string, string>;
  invoice_settings: {
    default_payment_method: string | null;
  } | null;
}

export interface StripeCustomerList {
  object: "list";
  data: StripeCustomer[];
  has_more: boolean;
  url: string;
}

export type StripePaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "canceled"
  | "succeeded";

export interface StripePaymentIntent {
  id: string;
  object: "payment_intent";
  amount: number;
  amount_received: number | null;
  currency: string;
  customer: string | null;
  status: StripePaymentIntentStatus;
  last_payment_error: { code?: string; message?: string } | null;
}

export interface StripePaymentIntentList {
  object: "list";
  url: string;
  data: StripePaymentIntent[];
  has_more: boolean;
}

export interface CustomerEnsureResult {
  customer_id: string;
}

export interface CheckoutSessionResult {
  url: string;
  session_id: string;
}

export interface PortalSessionResult {
  url: string;
}

export interface StripeBillingStatsGrowthRow {
  period: string;
  paid_cents: string;
}

export interface StripeBillingStatsResult {
  total_paid_cents: string;
  accounts_with_payment_method: number;
  monthly_growth: StripeBillingStatsGrowthRow[];
  weekly_growth: StripeBillingStatsGrowthRow[];
}

function getConfig() {
  const url = process.env.STRIPE_SERVICE_URL;
  const apiKey = process.env.STRIPE_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("STRIPE_SERVICE_URL and STRIPE_SERVICE_API_KEY must be configured");
  }
  return { url, apiKey };
}

function buildHeaders(
  identity: IdentityHeaders,
  apiKey: string,
  extra?: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = { "x-api-key": apiKey, "content-type": "application/json" };
  for (const [k, v] of Object.entries(identity)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
  }
  return out;
}

async function call<T>(
  method: "GET" | "POST",
  path: string,
  identity: IdentityHeaders,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const { url, apiKey } = getConfig();
  const res = await fetch(`${url}${path}`, {
    method,
    headers: buildHeaders(identity, apiKey, extraHeaders),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`stripe-service ${method} ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

// --- Customer ---

export async function ensureCustomer(identity: IdentityHeaders): Promise<CustomerEnsureResult> {
  return call("POST", "/v1/customers", identity, {});
}

/**
 * Org-implicit customer fetch. Stripe-service resolves the org's Stripe customer
 * server-side from x-org-id (1:1 org ↔ customer assumption).
 *
 * Returns the first (and only) customer in the list. Throws if none exists.
 */
export async function getCustomerByOrg(identity: IdentityHeaders): Promise<StripeCustomer> {
  const list = await call<StripeCustomerList>("GET", "/v1/customers?limit=1", identity);
  const customer = list.data[0];
  if (!customer) {
    throw new Error("stripe-service returned empty customer list for org");
  }
  return customer;
}

// --- PaymentIntent ---

export async function createPaymentIntent(
  identity: IdentityHeaders,
  body: {
    amount: number;
    currency: string;
    customer: string;
    confirm: boolean;
    off_session: boolean;
    metadata?: Record<string, string>;
  },
  idempotencyKey?: string
): Promise<StripePaymentIntent> {
  const extra = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
  return call("POST", "/v1/payment_intents", identity, body, extra);
}

export async function getPaymentIntent(
  id: string,
  identity: IdentityHeaders
): Promise<StripePaymentIntent> {
  return call("GET", `/v1/payment_intents/${id}`, identity);
}

export async function listPaymentIntents(
  identity: IdentityHeaders,
  query: { customer: string; limit?: number; starting_after?: string }
): Promise<StripePaymentIntentList> {
  const params = new URLSearchParams();
  params.set("customer", query.customer);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.starting_after) params.set("starting_after", query.starting_after);
  return call("GET", `/v1/payment_intents?${params.toString()}`, identity);
}

const TOPUP_PAGE_LIMIT = 100;
const TOPUP_PAGE_CAP = 200;

/**
 * Paginate every payment_intent for `customerId` and sum `amount_received`
 * across rows with `status === 'succeeded'`. The result is the total money
 * the org has actually paid into Stripe — the source of truth for the
 * billing-side `balance_cents` post-#0016.
 *
 * Returns a numeric(16,10)-formatted string for arithmetic-compatibility
 * with addCents/subCents helpers.
 *
 * Throws if pagination loops past TOPUP_PAGE_CAP pages or if stripe-service
 * reports `has_more=true` with an empty page (broken contract).
 */
export async function sumSucceededTopupsForCustomer(
  identity: IdentityHeaders,
  customerId: string
): Promise<string> {
  let total = new Decimal(0);
  let startingAfter: string | undefined;
  for (let i = 0; i < TOPUP_PAGE_CAP; i += 1) {
    const page = await listPaymentIntents(identity, {
      customer: customerId,
      limit: TOPUP_PAGE_LIMIT,
      starting_after: startingAfter,
    });
    for (const pi of page.data) {
      if (pi.status === "succeeded" && typeof pi.amount_received === "number") {
        total = total.plus(pi.amount_received);
      }
    }
    if (!page.has_more) {
      return total.toFixed(10);
    }
    const last = page.data[page.data.length - 1];
    if (!last) {
      throw new Error(
        "stripe-service /v1/payment_intents returned has_more=true with empty page"
      );
    }
    startingAfter = last.id;
  }
  throw new Error(
    `stripe-service /v1/payment_intents pagination exceeded ${TOPUP_PAGE_CAP} pages for customer ${customerId}`
  );
}

// --- Checkout / Portal ---

export async function createCheckoutSession(
  identity: IdentityHeaders,
  body: { success_url: string; cancel_url: string; topup_amount_cents: number }
): Promise<CheckoutSessionResult> {
  return call("POST", "/v1/checkout/sessions", identity, body);
}

export async function createPortalSession(
  identity: IdentityHeaders,
  body: { return_url: string }
): Promise<PortalSessionResult> {
  return call("POST", "/v1/billing_portal/sessions", identity, body);
}

// --- Public Stats ---

export async function getStats(identity: IdentityHeaders): Promise<StripeBillingStatsResult> {
  return call("GET", "/public/stats/billing", identity);
}

// --- Customer list-by-metadata + update ---

/**
 * List customers whose Stripe metadata matches every key/value pair in `metadata`.
 * stripe-service AND's multiple metadata keys server-side. Values must be strings.
 */
export async function listCustomersByMetadata(
  identity: IdentityHeaders,
  query: {
    metadata: Record<string, string>;
    limit?: number;
    starting_after?: string;
  }
): Promise<StripeCustomerList> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query.metadata)) {
    params.set(`metadata[${k}]`, v);
  }
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.starting_after) params.set("starting_after", query.starting_after);
  return call("GET", `/v1/customers?${params.toString()}`, identity);
}

export async function updateCustomer(
  customerId: string,
  identity: IdentityHeaders,
  body: { metadata: Record<string, string> }
): Promise<StripeCustomer> {
  return call("POST", `/v1/customers/${customerId}`, identity, body);
}

// --- Derivations from Stripe customer ---

export function deriveHasPaymentMethod(customer: StripeCustomer): boolean {
  return Boolean(customer.invoice_settings?.default_payment_method);
}
