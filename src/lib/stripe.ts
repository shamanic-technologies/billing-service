import Stripe from "stripe";
import { resolveAppKey } from "./key-client.js";

// Per-app Stripe instance cache (each app has its own Stripe key)
const stripeInstances = new Map<string, Stripe>();
const webhookSecrets = new Map<string, string>();

// Test override — applies to all apps
let testStripeInstance: Stripe | null = null;

async function getStripe(appId: string): Promise<Stripe> {
  if (testStripeInstance) return testStripeInstance;

  let instance = stripeInstances.get(appId);
  if (!instance) {
    const key = await resolveAppKey("stripe", appId);
    instance = new Stripe(key, { apiVersion: "2024-12-18.acacia" as Stripe.LatestApiVersion });
    stripeInstances.set(appId, instance);
  }
  return instance;
}

/**
 * Wraps a Stripe API call with retry-on-auth-error logic.
 * If the Stripe key is expired/invalid, evicts the cached instance and retries
 * once with a freshly resolved key from key-service.
 */
async function withAuthRetry<T>(appId: string, fn: (stripe: Stripe) => Promise<T>): Promise<T> {
  const stripe = await getStripe(appId);
  try {
    return await fn(stripe);
  } catch (err) {
    if (isStripeAuthError(err)) {
      console.warn(`Stripe auth error for app ${appId} — evicting cached key and retrying`);
      stripeInstances.delete(appId);
      const freshStripe = await getStripe(appId);
      return fn(freshStripe);
    }
    throw err;
  }
}

/** Check if an error is a Stripe authentication error (expired/invalid key). */
export function isStripeAuthError(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeAuthenticationError;
}

/** Override Stripe instance for all apps (tests only). */
export function setStripeInstance(mock: Stripe): void {
  testStripeInstance = mock;
}

// --- Customer ---

export async function createCustomer(
  appId: string,
  orgId: string,
  metadata?: Record<string, string>
): Promise<Stripe.Customer> {
  return withAuthRetry(appId, (stripe) =>
    stripe.customers.create({
      metadata: { org_id: orgId, app_id: appId, ...metadata },
    })
  );
}

export async function getCustomer(
  appId: string,
  stripeCustomerId: string
): Promise<Stripe.Customer> {
  return withAuthRetry(appId, (stripe) =>
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
  appId: string,
  stripeCustomerId: string,
  amountCents: number,
  description: string,
  metadata?: Record<string, string>
): Promise<Stripe.CustomerBalanceTransaction> {
  return withAuthRetry(appId, (stripe) =>
    stripe.customers.createBalanceTransaction(stripeCustomerId, {
      amount: amountCents,
      currency: "usd",
      description,
      metadata,
    })
  );
}

export async function listBalanceTransactions(
  appId: string,
  stripeCustomerId: string,
  limit = 50
): Promise<Stripe.ApiList<Stripe.CustomerBalanceTransaction>> {
  return withAuthRetry(appId, (stripe) =>
    stripe.customers.listBalanceTransactions(stripeCustomerId, {
      limit,
    })
  );
}

// --- Checkout ---

export async function createCheckoutSession(
  appId: string,
  stripeCustomerId: string,
  successUrl: string,
  cancelUrl: string,
  reloadAmountCents: number
): Promise<Stripe.Checkout.Session> {
  return withAuthRetry(appId, (stripe) =>
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
  appId: string,
  stripeCustomerId: string,
  paymentMethodId: string,
  amountCents: number,
  description: string
): Promise<Stripe.PaymentIntent> {
  return withAuthRetry(appId, (stripe) =>
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

// --- Webhook ---

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
  const stripe = await getStripe(appId);
  return stripe.webhooks.constructEvent(payload, signature, secret);
}
