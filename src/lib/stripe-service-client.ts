/**
 * HTTP client for stripe-service.
 *
 * Stripe-service wraps all Stripe SDK calls + webhook handling. Billing-service
 * never touches Stripe directly post-#0016.
 *
 * Paths follow Stripe-natural resource naming where it maps cleanly
 * (`/v1/customers`, `/v1/checkout/sessions`, `/v1/billing_portal/sessions`).
 * Custom endpoints (`/balance`, `/has-payment-method`, `/reload`,
 * `/transfer-brand`, `/stats/billing`) live under `/v1/customers/*` and
 * `/internal/*` because they have no native Stripe analogue.
 *
 * REBASE NOTE: the stripe-service OpenAPI was not yet indexed in api-registry
 * at write time. Once it lands, re-align this file against the canonical spec
 * — it is the single integration point.
 */

/**
 * Identity headers for downstream service calls. Callers MUST include
 * `x-org-id` and `x-user-id`; other workflow-tracking headers are optional.
 * Typed as a plain string record so it composes with `forwardWorkflowHeaders`.
 */
export type IdentityHeaders = Record<string, string>;

export interface CustomerEnsureResult {
  customer_id: string;
}

export interface CustomerBalanceResult {
  balance_cents: string;
}

export interface HasPaymentMethodResult {
  has_payment_method: boolean;
}

export interface ReloadResult {
  status: "succeeded" | "failed";
  payment_intent_id?: string;
  failure_reason?: string;
}

export interface CheckoutSessionResult {
  url: string;
  session_id: string;
}

export interface PortalSessionResult {
  url: string;
}

export interface StripeTransactionRow {
  id: string;
  object: "customer_balance_transaction";
  amount_cents: string;
  type: "payment" | "refund";
  status: "requires_capture" | "succeeded" | "canceled";
  stripe_payment_intent_id: string | null;
  stripe_balance_transaction_id: string | null;
  description: string | null;
  created: number;
}

export interface ListTransactionsResult {
  object: "list";
  data: StripeTransactionRow[];
  has_more: boolean;
}

export interface TransferBrandResult {
  count: number;
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

function buildHeaders(identity: IdentityHeaders, apiKey: string): Record<string, string> {
  const out: Record<string, string> = { "x-api-key": apiKey, "content-type": "application/json" };
  for (const [k, v] of Object.entries(identity)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

async function call<T>(
  method: "GET" | "POST",
  path: string,
  identity: IdentityHeaders,
  body?: unknown
): Promise<T> {
  const { url, apiKey } = getConfig();
  const res = await fetch(`${url}${path}`, {
    method,
    headers: buildHeaders(identity, apiKey),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`stripe-service ${method} ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export async function ensureCustomer(identity: IdentityHeaders): Promise<CustomerEnsureResult> {
  return call("POST", "/v1/customers", identity, {});
}

export async function getBalance(identity: IdentityHeaders): Promise<CustomerBalanceResult> {
  return call("GET", "/v1/customers/balance", identity);
}

export async function hasPaymentMethod(identity: IdentityHeaders): Promise<HasPaymentMethodResult> {
  return call("GET", "/v1/customers/has-payment-method", identity);
}

export async function reload(
  identity: IdentityHeaders,
  body: { amount_cents: number; idempotency_key: string }
): Promise<ReloadResult> {
  return call("POST", "/v1/customers/reload", identity, body);
}

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

export async function listTransactions(
  identity: IdentityHeaders,
  query: { limit?: number } = {}
): Promise<ListTransactionsResult> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  return call("GET", `/v1/customer_balance_transactions${qs ? `?${qs}` : ""}`, identity);
}

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

export async function getStats(identity: IdentityHeaders): Promise<StripeBillingStatsResult> {
  return call("GET", "/public/stats/billing", identity);
}
