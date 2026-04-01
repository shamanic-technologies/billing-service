import Stripe from "stripe";
import PQueue from "p-queue";
import crypto from "crypto";
import { resolvePlatformKey, type IdentityContext } from "./key-client.js";

// --- Single Stripe instance (platform key is global) ---

let cachedStripe: Stripe | null = null;
let cachedWebhookSecret: string | null = null;

// Test override
let testStripeInstance: Stripe | null = null;

// Concurrency limiter: prevents endpoint-concurrency 429s from Stripe.
// Stripe's per-endpoint concurrency limit is ~25; we cap at 10 to stay well under.
const stripeQueue = new PQueue({ concurrency: 10 });

// Expose for tests
export { stripeQueue };

const MAX_429_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

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

/** Check if an error is a Stripe 429 rate limit error. */
function isRateLimitError(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeRateLimitError;
}

/**
 * Sleep with jitter for exponential backoff.
 * Uses full jitter: random between 0 and base * 2^attempt.
 */
function backoffMs(attempt: number): number {
  const ceiling = BASE_BACKOFF_MS * Math.pow(2, attempt);
  return Math.floor(Math.random() * ceiling);
}

/**
 * Wraps a Stripe API call with:
 * 1. Concurrency limiting (p-queue) to prevent endpoint-concurrency 429s
 * 2. 429-specific retry with exponential backoff + jitter
 * 3. Auth error retry (evict cached key, re-resolve from key-service)
 */
async function withRetry<T>(identity: IdentityContext, fn: (stripe: Stripe) => Promise<T>): Promise<T> {
  return stripeQueue.add(async () => {
    const stripe = await getStripe(identity);

    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
      try {
        return await fn(stripe);
      } catch (err) {
        if (isStripeAuthError(err)) {
          console.warn("[billing-service] Stripe auth error — evicting cached platform key and retrying");
          cachedStripe = null;
          const freshStripe = await getStripe(identity);
          return fn(freshStripe);
        }

        if (isRateLimitError(err) && attempt < MAX_429_RETRIES) {
          const delay = backoffMs(attempt);
          console.warn(`[billing-service] Stripe 429 — retry ${attempt + 1}/${MAX_429_RETRIES} in ${delay}ms`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw err;
      }
    }

    // Unreachable, but TypeScript needs it
    throw new Error("[billing-service] Exhausted 429 retries");
  }) as Promise<T>;
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
  return withRetry(buildIdentity(orgId, userId, workflowHeaders), (stripe) =>
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
  return withRetry(buildIdentity(orgId, userId, workflowHeaders), (stripe) =>
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
  return withRetry(buildIdentity(orgId, userId, workflowHeaders), (stripe) =>
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
  return withRetry(buildIdentity(orgId, userId, workflowHeaders), (stripe) =>
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
  return withRetry(buildIdentity(orgId, userId, workflowHeaders), (stripe) =>
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

/**
 * Deterministic idempotency key for auto-reload charges.
 * Prevents duplicate charges if the same reload is retried.
 * Hash includes orgId + customerId + amount + a time bucket (1-minute window)
 * so the same org can't be double-charged within the same minute.
 */
function reloadIdempotencyKey(orgId: string, stripeCustomerId: string, amountCents: number): string {
  const timeBucket = Math.floor(Date.now() / 60_000);
  const input = `reload:${orgId}:${stripeCustomerId}:${amountCents}:${timeBucket}`;
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 32);
}

export async function chargePaymentMethod(
  orgId: string,
  userId: string,
  stripeCustomerId: string,
  paymentMethodId: string,
  amountCents: number,
  description: string,
  workflowHeaders?: Record<string, string>
): Promise<Stripe.PaymentIntent> {
  const idempotencyKey = reloadIdempotencyKey(orgId, stripeCustomerId, amountCents);
  return withRetry(buildIdentity(orgId, userId, workflowHeaders), (stripe) =>
    stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: "usd",
        customer: stripeCustomerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description,
        metadata: { type: "auto_reload" },
      },
      { idempotencyKey }
    )
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
  return withRetry(buildIdentity(orgId, userId, workflowHeaders), (stripe) =>
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
  return withRetry(identity, (stripe) =>
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
