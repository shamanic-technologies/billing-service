import Stripe from "stripe";
import { resolveAppKey, resolveKey, type KeySource } from "./key-client.js";

// --- Key source info type ---

export type KeySourceInfo =
  | { keySource: "app"; appId: string }
  | { keySource: "byok"; orgId: string }
  | { keySource: "platform" };

function cacheKey(info: KeySourceInfo): string {
  switch (info.keySource) {
    case "app": return `app:${info.appId}`;
    case "byok": return `byok:${info.orgId}`;
    case "platform": return "platform";
  }
}

function resolveOpts(info: KeySourceInfo): { appId?: string; orgId?: string } {
  switch (info.keySource) {
    case "app": return { appId: info.appId };
    case "byok": return { orgId: info.orgId };
    case "platform": return {};
  }
}

// --- Stripe instance cache (keyed by keySource:identifier) ---

const stripeInstances = new Map<string, Stripe>();
const webhookSecrets = new Map<string, string>();

// Test override — applies to all key sources
let testStripeInstance: Stripe | null = null;

async function getStripe(info: KeySourceInfo): Promise<Stripe> {
  if (testStripeInstance) return testStripeInstance;

  const ck = cacheKey(info);
  let instance = stripeInstances.get(ck);
  if (!instance) {
    const key = await resolveKey("stripe", info.keySource, resolveOpts(info));
    instance = new Stripe(key, { apiVersion: "2024-12-18.acacia" as Stripe.LatestApiVersion });
    stripeInstances.set(ck, instance);
  }
  return instance;
}

/**
 * Wraps a Stripe API call with retry-on-auth-error logic.
 * If the Stripe key is expired/invalid, evicts the cached instance and retries
 * once with a freshly resolved key from key-service.
 */
async function withAuthRetry<T>(info: KeySourceInfo, fn: (stripe: Stripe) => Promise<T>): Promise<T> {
  const stripe = await getStripe(info);
  try {
    return await fn(stripe);
  } catch (err) {
    if (isStripeAuthError(err)) {
      const ck = cacheKey(info);
      console.warn(`Stripe auth error for ${ck} — evicting cached key and retrying`);
      stripeInstances.delete(ck);
      const freshStripe = await getStripe(info);
      return fn(freshStripe);
    }
    throw err;
  }
}

/** Check if an error is a Stripe authentication error (expired/invalid key). */
export function isStripeAuthError(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeAuthenticationError;
}

/** Override Stripe instance for all key sources (tests only). */
export function setStripeInstance(mock: Stripe): void {
  testStripeInstance = mock;
}

// --- Customer ---

export async function createCustomer(
  info: KeySourceInfo,
  orgId: string,
  metadata?: Record<string, string>
): Promise<Stripe.Customer> {
  return withAuthRetry(info, (stripe) =>
    stripe.customers.create({
      metadata: { org_id: orgId, key_source: info.keySource, ...metadata },
    })
  );
}

export async function getCustomer(
  info: KeySourceInfo,
  stripeCustomerId: string
): Promise<Stripe.Customer> {
  return withAuthRetry(info, (stripe) =>
    stripe.customers.retrieve(stripeCustomerId) as Promise<Stripe.Customer>
  );
}

// --- Customer Balance ---

/**
 * Stripe balance semantics:
 * - Negative balance = customer has credit (money available)
 * - Positive balance = customer owes money
 *
 * We use positive `amountCents` for deductions (increases balance towards positive)
 * and negative `amountCents` for credits (decreases balance towards negative).
 */
export async function createBalanceTransaction(
  info: KeySourceInfo,
  stripeCustomerId: string,
  amountCents: number,
  description: string,
  metadata?: Record<string, string>
): Promise<Stripe.CustomerBalanceTransaction> {
  return withAuthRetry(info, (stripe) =>
    stripe.customers.createBalanceTransaction(stripeCustomerId, {
      amount: amountCents,
      currency: "usd",
      description,
      metadata,
    })
  );
}

export async function listBalanceTransactions(
  info: KeySourceInfo,
  stripeCustomerId: string,
  limit = 50
): Promise<Stripe.ApiList<Stripe.CustomerBalanceTransaction>> {
  return withAuthRetry(info, (stripe) =>
    stripe.customers.listBalanceTransactions(stripeCustomerId, {
      limit,
    })
  );
}

// --- Checkout ---

export async function createCheckoutSession(
  info: KeySourceInfo,
  stripeCustomerId: string,
  successUrl: string,
  cancelUrl: string,
  reloadAmountCents: number
): Promise<Stripe.Checkout.Session> {
  return withAuthRetry(info, (stripe) =>
    stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Credit Reload" },
            unit_amount: reloadAmountCents,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata: { type: "initial_reload" },
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { reload_amount_cents: String(reloadAmountCents) },
    })
  );
}

// --- Payment (auto-reload) ---

export async function chargePaymentMethod(
  info: KeySourceInfo,
  stripeCustomerId: string,
  paymentMethodId: string,
  amountCents: number,
  description: string
): Promise<Stripe.PaymentIntent> {
  return withAuthRetry(info, (stripe) =>
    stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      customer: stripeCustomerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      description,
      metadata: { type: "auto_reload" },
    })
  );
}

// --- Webhook (always uses app key source) ---

export async function constructWebhookEvent(
  appId: string,
  payload: Buffer,
  signature: string
): Promise<Stripe.Event> {
  let secret = webhookSecrets.get(appId);
  if (!secret) {
    secret = await resolveAppKey("stripe-webhook", appId, {
      service: "billing",
      method: "POST",
      path: "/v1/webhooks/stripe",
    });
    webhookSecrets.set(appId, secret);
  }
  const info: KeySourceInfo = { keySource: "app", appId };
  const stripe = await getStripe(info);
  return stripe.webhooks.constructEvent(payload, signature, secret);
}
