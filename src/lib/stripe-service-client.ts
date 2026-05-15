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
  balance: number;
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
  currency: string;
  customer: string | null;
  status: StripePaymentIntentStatus;
  last_payment_error: { code?: string; message?: string } | null;
}

export interface StripeBalanceTransaction {
  id: string;
  object: "customer_balance_transaction";
  amount: number;
  currency: string;
  type: string;
  customer: string;
  credit_note: string | null;
  invoice: string | null;
  description: string | null;
  metadata: Record<string, string>;
  created: number;
  livemode: boolean;
}

export interface StripeBalanceTransactionList {
  object: "list";
  url: string;
  data: StripeBalanceTransaction[];
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

// --- Balance Transactions (org-implicit) ---

export async function listBalanceTransactions(
  identity: IdentityHeaders,
  query: { limit?: number; starting_after?: string; ending_before?: string } = {}
): Promise<StripeBalanceTransactionList> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.starting_after) params.set("starting_after", query.starting_after);
  if (query.ending_before) params.set("ending_before", query.ending_before);
  const qs = params.toString();
  return call("GET", `/v1/balance_transactions${qs ? `?${qs}` : ""}`, identity);
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

// --- DEPRECATED: transfer-brand ---

export interface TransferBrandResult {
  count: number;
}

/**
 * @deprecated stripe-service no longer exposes /internal/transfer-brand.
 * Replacement is a billing-side compose: list customers via
 * `GET /v1/customers?metadata[org_id]=...` then PATCH each via
 * `POST /v1/customers/:id`. Blocked on stripe-service wiring the
 * `metadata[*]` query filter on the list endpoint. See follow-up T5.
 */
export async function transferBrand(
  identity: IdentityHeaders,
  body: {
    sourceBrandId: string;
    sourceOrgId: string;
    targetOrgId: string;
    targetBrandId?: string;
  }
): Promise<TransferBrandResult> {
  return call("POST", "/internal/transfer-brand", identity, body);
}

// --- Derivations from Stripe customer ---

/**
 * Derive billing-side balance_cents (positive=credit) from Stripe customer.balance
 * (positive=customer-owes, negative=customer-credit). Sign-flip mirrors the
 * old getBalance semantics. Returned as numeric(16,10)-formatted string for
 * arithmetic-compatibility with addCents/subCents helpers.
 */
export function deriveBalanceCents(customer: StripeCustomer): string {
  const stripeBalance = customer.balance ?? 0;
  return new Decimal(-stripeBalance).toFixed(10);
}

export function deriveHasPaymentMethod(customer: StripeCustomer): boolean {
  return Boolean(customer.invoice_settings?.default_payment_method);
}
