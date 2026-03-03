import Stripe from "stripe";
import { resolveProviderKey } from "./key-client.js";

// --- Stripe instance cache (keyed by org) ---

const stripeInstances = new Map<string, Stripe>();
const webhookSecrets = new Map<string, string>();

// Test override — applies to all key sources
let testStripeInstance: Stripe | null = null;

async function getStripe(orgId: string, userId: string): Promise<Stripe> {
  if (testStripeInstance) return testStripeInstance;

  const ck = `org:${orgId}`;
  let instance = stripeInstances.get(ck);
  if (!instance) {
    const { key } = await resolveProviderKey("stripe", orgId, userId);
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
async function withAuthRetry<T>(orgId: string, userId: string, fn: (stripe: Stripe) => Promise<T>): Promise<T> {
  const stripe = await getStripe(orgId, userId);
  try {
    return await fn(stripe);
  } catch (err) {
    if (isStripeAuthError(err)) {
      const ck = `org:${orgId}`;
      console.warn(`Stripe auth error for ${ck} — evicting cached key and retrying`);
      stripeInstances.delete(ck);
      const freshStripe = await getStripe(orgId, userId);
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
  orgId: string,
  userId: string,
  metadata?: Record<string, string>
): Promise<Stripe.Customer> {
  return withAuthRetry(orgId, userId, (stripe) =>
    stripe.customers.create({
      metadata: { org_id: orgId, ...metadata },
    })
  );
}

export async function getCustomer(
  orgId: string,
  userId: string,
  stripeCustomerId: string
): Promise<Stripe.Customer> {
  return withAuthRetry(orgId, userId, (stripe) =>
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
  orgId: string,
  userId: string,
  stripeCustomerId: string,
  amountCents: number,
  description: string,
  metadata?: Record<string, string>
): Promise<Stripe.CustomerBalanceTransaction> {
  return withAuthRetry(orgId, userId, (stripe) =>
    stripe.customers.createBalanceTransaction(stripeCustomerId, {
      amount: amountCents,
      currency: "usd",
      description,
      metadata,
    })
  );
}

export async function listBalanceTransactions(
  orgId: string,
  userId: string,
  stripeCustomerId: string,
  limit = 50
): Promise<Stripe.ApiList<Stripe.CustomerBalanceTransaction>> {
  return withAuthRetry(orgId, userId, (stripe) =>
    stripe.customers.listBalanceTransactions(stripeCustomerId, {
      limit,
    })
  );
}

// --- Checkout ---

export async function createCheckoutSession(
  orgId: string,
  userId: string,
  stripeCustomerId: string,
  successUrl: string,
  cancelUrl: string,
  reloadAmountCents: number
): Promise<Stripe.Checkout.Session> {
  return withAuthRetry(orgId, userId, (stripe) =>
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
  orgId: string,
  userId: string,
  stripeCustomerId: string,
  paymentMethodId: string,
  amountCents: number,
  description: string
): Promise<Stripe.PaymentIntent> {
  return withAuthRetry(orgId, userId, (stripe) =>
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
  orgId: string,
  payload: Buffer,
  signature: string
): Promise<Stripe.Event> {
  let secret = webhookSecrets.get(orgId);
  if (!secret) {
    const result = await resolveProviderKey("stripe-webhook", orgId, "system", {
      service: "billing",
      method: "POST",
      path: "/v1/webhooks/stripe",
    });
    secret = result.key;
    webhookSecrets.set(orgId, secret);
  }
  const stripe = await getStripe(orgId, "system");
  return stripe.webhooks.constructEvent(payload, signature, secret);
}
