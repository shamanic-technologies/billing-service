/**
 * HTTP client for stripe-service's per-brand subscription passthrough.
 *
 * The recurring daily Stripe subscription is owned + plumbed by stripe-service
 * (create / update-amount / pause / resume, plus the Stripe webhooks). billing
 * never touches Stripe directly — it calls these by-brand primitives and keeps
 * the brand daily-budget in sync. The subscription is resolved server-side by
 * brand metadata (mirrors getCustomerByOrg's org-implicit resolution), so billing
 * stores NO Stripe subscription id (CLAUDE.md: never duplicate Stripe state).
 *
 * Same base + auth as stripe-service-client (STRIPE_SERVICE_URL + X-API-Key).
 * Fail-loud: every non-2xx throws.
 *
 * LOCKED contract (billing ↔ stripe-service), byte-equal both sides:
 *   POST   /internal/subscriptions/by-brand/:brandId          {orgId,userId,dailyAmountCents}
 *   PATCH  /internal/subscriptions/by-brand/:brandId          {dailyAmountCents}
 *   POST   /internal/subscriptions/by-brand/:brandId/pause
 *   POST   /internal/subscriptions/by-brand/:brandId/resume
 */

import { fetchWithRetry } from "./fetch-retry.js";

export interface BrandSubscription {
  subscriptionId: string;
  status: string;
  /** The recurring per-day amount in integer cents. Absent on pause responses. */
  dailyAmountCents?: number;
  brandId: string;
}

function getConfig() {
  const url = process.env.STRIPE_SERVICE_URL;
  const apiKey = process.env.STRIPE_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error(
      "STRIPE_SERVICE_URL and STRIPE_SERVICE_API_KEY must be configured"
    );
  }
  return { url, apiKey };
}

async function call<T>(
  method: "POST" | "PATCH",
  path: string,
  body?: unknown
): Promise<T> {
  const { url, apiKey } = getConfig();
  const res = await fetchWithRetry(`${url}${path}`, {
    method,
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `stripe-service ${method} ${path} failed: ${res.status} ${text}`
    );
  }
  return (await res.json()) as T;
}

function base(brandId: string): string {
  return `/internal/subscriptions/by-brand/${encodeURIComponent(brandId)}`;
}

/** Create the brand's recurring daily subscription. Idempotent server-side. */
export async function createBrandSubscription(
  brandId: string,
  body: { orgId: string; userId: string; dailyAmountCents: number }
): Promise<BrandSubscription> {
  return call("POST", base(brandId), body);
}

/** Update the brand subscription's recurring amount. */
export async function updateBrandSubscriptionAmount(
  brandId: string,
  dailyAmountCents: number
): Promise<BrandSubscription> {
  return call("PATCH", base(brandId), { dailyAmountCents });
}

/** Pause collection on the brand subscription (brand went dry). */
export async function pauseBrandSubscription(
  brandId: string
): Promise<BrandSubscription> {
  return call("POST", `${base(brandId)}/pause`);
}

/** Resume collection; the response carries the restored daily amount. */
export async function resumeBrandSubscription(
  brandId: string
): Promise<BrandSubscription> {
  return call("POST", `${base(brandId)}/resume`);
}
