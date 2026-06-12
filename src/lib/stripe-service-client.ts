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

export interface StripePaymentMethod {
  id: string;
  object: "payment_method";
  type: string;
}

export interface StripePaymentMethodList {
  object: "list";
  url: string;
  data: StripePaymentMethod[];
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
    payment_method?: string;
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

/**
 * List a customer's attached PaymentMethods via stripe-service.
 * Live passthrough to Stripe `paymentMethods.list({ customer, type? })`.
 *
 * Used by reload.ts to pick an explicit `payment_method` for off_session PIs
 * instead of relying on `customer.invoice_settings.default_payment_method`
 * (which may be a Link / wallet PM Stripe refuses to charge off_session).
 */
export async function listPaymentMethods(
  identity: IdentityHeaders,
  query: { customer: string; type?: string }
): Promise<StripePaymentMethodList> {
  const params = new URLSearchParams();
  params.set("customer", query.customer);
  if (query.type) params.set("type", query.type);
  return call("GET", `/v1/payment_methods?${params.toString()}`, identity);
}

const TOPUP_PAGE_LIMIT = 100;
const TOPUP_PAGE_CAP = 200;

/**
 * Paginate every payment_intent for `customerId` and sum `amount_received`
 * across rows with `status === 'succeeded'`. The result is the total money
 * the org has actually paid into Stripe — the paid-topups component of
 * billing-side `credited_cents`.
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

export interface CheckoutLineItem {
  price_data: {
    currency: string;
    product_data: { name: string };
    unit_amount: number;
  };
  quantity: number;
}

export interface CheckoutSessionBody {
  mode: "payment" | "subscription" | "setup";
  /** Required by Stripe for setup mode when payment_method_types is omitted. */
  currency?: string;
  /** Required for payment mode; omitted for setup mode (no charge). */
  line_items?: CheckoutLineItem[];
  success_url: string;
  cancel_url: string;
  customer: string;
  metadata: Record<string, string>;
  /** Payment-mode charge config; omitted for setup mode (no PaymentIntent created). */
  payment_intent_data?: {
    metadata: Record<string, string>;
    setup_future_usage?: "off_session" | "on_session";
  };
}

export async function createCheckoutSession(
  identity: IdentityHeaders,
  body: CheckoutSessionBody
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

/**
 * True iff the org's Stripe customer has at least one CHARGEABLE attached payment
 * method — a `card` OR a `link` PM. Both are reusable off_session: Stripe documents
 * charging a saved `type:link` PM with `off_session:true, confirm:true` exactly like a
 * card (https://docs.stripe.com/payments/link/save-and-reuse — "Charge the saved
 * payment method later"). A normal Checkout setup-mode flow that offers card+link
 * saves the PM as `type:link` for Link-enabled emails, so a card-only gate wrongly
 * reported "no payment method" for those orgs and blocked auto-topup forever.
 *
 * This is the chargeable-PM definition shared by the reload gates (authorize /
 * usage_apply) and the public `has_payment_method` surface. It MUST mirror what
 * `reload.ts` actually charges — first card, then link fallback.
 *
 * Deliberately NOT keyed on `customer.invoice_settings.default_payment_method`:
 * Stripe leaves that null after a normal `setup_future_usage` checkout. We list the
 * attached PMs by type instead, so a chargeable card/link is found regardless.
 *
 * Fail-loud: a stripe-service error (404 customer-not-in-mirror, timeout, 5xx) is
 * propagated by `listPaymentMethods`. ONLY an empty card AND link list returns false —
 * an error is never collapsed into "no payment method".
 */
export async function hasAttachedCardPm(
  identity: IdentityHeaders,
  customerId: string
): Promise<boolean> {
  const cards = await listPaymentMethods(identity, { customer: customerId, type: "card" });
  if (cards.data.length > 0) return true;
  const links = await listPaymentMethods(identity, { customer: customerId, type: "link" });
  return links.data.length > 0;
}
