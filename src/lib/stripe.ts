import Stripe from "stripe";
import { resolvePlatformKey, type IdentityContext } from "./key-client.js";

// --- Single Stripe instance (platform key is global) ---

let cachedStripe: Stripe | null = null;
let cachedWebhookSecret: string | null = null;

// Test override
let testStripeInstance: Stripe | null = null;

function buildIdentity(orgId: string, userId: string, workflowHeaders?: Record<string, string>): IdentityContext {
  return { orgId, userId, workflowHeaders };
}

async function getStripe(identity: IdentityContext): Promise<Stripe> {
  if (testStripeInstance) return testStripeInstance;

  if (!cachedStripe) {
    const { key } = await resolvePlatformKey("stripe", identity);
    cachedStripe = new Stripe(key, {
      apiVersion: "2024-12-18.acacia" as Stripe.LatestApiVersion,
      maxNetworkRetries: 5,
    });
  }
  return cachedStripe;
}

/**
 * Wraps a Stripe API call with retry-on-auth-error logic.
 * If the Stripe key is expired/invalid, evicts the cached instance and retries
 * once with a freshly resolved key from key-service.
 */
async function withAuthRetry<T>(identity: IdentityContext, fn: (stripe: Stripe) => Promise<T>): Promise<T> {
  const stripe = await getStripe(identity);
  try {
    return await fn(stripe);
  } catch (err) {
    if (isStripeAuthError(err)) {
      console.warn("Stripe auth error — evicting cached platform key and retrying");
      cachedStripe = null;
      const freshStripe = await getStripe(identity);
      return fn(freshStripe);
    }
    throw err;
  }
}

/** Check if an error is a Stripe authentication error (expired/invalid key). */
export function isStripeAuthError(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeAuthenticationError;
}

/** Override Stripe instance for tests. */
export function setStripeInstance(mock: Stripe): void {
  testStripeInstance = mock;
}

// --- Customer ---

export async function createCustomer(
  orgId: string,
  userId: string,
  metadata?: Record<string, string>,
  workflowHeaders?: Record<string, string>
): Promise<Stripe.Customer> {
  return withAuthRetry(buildIdentity(orgId, userId, workflowHeaders), (stripe) =>
    stripe.customers.create({
      metadata: { org_id: orgId, ...metadata },
    })
  );
}

export async function getCustomer(
  orgId: string,
  userId: string,
  stripeCustomerId: string,
  workflowHeaders?: Record<string, string>
): Promise<Stripe.Customer> {
  return withAuthRetry(buildIdentity(orgId, userId, workflowHeaders), (stripe) =>
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
  metadata?: Record<string, string>,
  workflowHeaders?: Record<string, string>
): Promise<Stripe.CustomerBalanceTransaction> {
  return withAuthRetry(buildIdentity(orgId, userId, workflowHeaders), (stripe) =>
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
  limit = 50,
  workflowHeaders?: Record<string, string>
): Promise<Stripe.ApiList<Stripe.CustomerBalanceTransaction>> {
  return withAuthRetry(buildIdentity(orgId, userId, workflowHeaders), (stripe) =>
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
  reloadAmountCents: number,
  workflowHeaders?: Record<string, string>
): Promise<Stripe.Checkout.Session> {
  return withAuthRetry(buildIdentity(orgId, userId, workflowHeaders), (stripe) =>
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
  description: string,
  workflowHeaders?: Record<string, string>
): Promise<Stripe.PaymentIntent> {
  return withAuthRetry(buildIdentity(orgId, userId, workflowHeaders), (stripe) =>
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

// --- Portal ---

export async function createPortalSession(
  orgId: string,
  userId: string,
  stripeCustomerId: string,
  returnUrl: string,
  workflowHeaders?: Record<string, string>
): Promise<Stripe.BillingPortal.Session> {
  return withAuthRetry(buildIdentity(orgId, userId, workflowHeaders), (stripe) =>
    stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: returnUrl,
    })
  );
}

// --- PaymentIntent retrieval ---

export async function retrievePaymentIntent(
  paymentIntentId: string
): Promise<Stripe.PaymentIntent> {
  const identity: IdentityContext = { orgId: "system", userId: "system" };
  return withAuthRetry(identity, (stripe) =>
    stripe.paymentIntents.retrieve(paymentIntentId)
  );
}

// --- Webhook ---

export async function constructWebhookEvent(
  payload: Buffer,
  signature: string
): Promise<Stripe.Event> {
  // Webhook calls come from Stripe, not from users — use "system" identity
  const identity: IdentityContext = { orgId: "system", userId: "system" };
  if (!cachedWebhookSecret) {
    const result = await resolvePlatformKey("stripe-webhook", identity, {
      service: "billing",
      method: "POST",
      path: "/v1/webhooks/stripe",
    });
    cachedWebhookSecret = result.key;
  }
  const stripe = await getStripe(identity);
  return stripe.webhooks.constructEvent(payload, signature, cachedWebhookSecret);
}
