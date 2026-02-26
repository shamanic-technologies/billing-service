import Stripe from "stripe";
import { resolveAppKey } from "./key-client.js";

let stripeInstance: Stripe | null = null;
let cachedWebhookSecret: string | null = null;

async function getStripe(): Promise<Stripe> {
  if (!stripeInstance) {
    const key = await resolveAppKey("stripe");
    stripeInstance = new Stripe(key, { apiVersion: "2024-12-18.acacia" as Stripe.LatestApiVersion });
  }
  return stripeInstance;
}

/** Override Stripe instance (for tests). */
export function setStripeInstance(mock: Stripe): void {
  stripeInstance = mock;
}

// --- Customer ---

export async function createCustomer(
  orgId: string,
  metadata?: Record<string, string>
): Promise<Stripe.Customer> {
  const stripe = await getStripe();
  return stripe.customers.create({
    metadata: { org_id: orgId, ...metadata },
  });
}

export async function getCustomer(
  stripeCustomerId: string
): Promise<Stripe.Customer> {
  const stripe = await getStripe();
  return stripe.customers.retrieve(
    stripeCustomerId
  ) as Promise<Stripe.Customer>;
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
  stripeCustomerId: string,
  amountCents: number,
  description: string,
  metadata?: Record<string, string>
): Promise<Stripe.CustomerBalanceTransaction> {
  const stripe = await getStripe();
  return stripe.customers.createBalanceTransaction(stripeCustomerId, {
    amount: amountCents,
    currency: "usd",
    description,
    metadata,
  });
}

export async function listBalanceTransactions(
  stripeCustomerId: string,
  limit = 50
): Promise<Stripe.ApiList<Stripe.CustomerBalanceTransaction>> {
  const stripe = await getStripe();
  return stripe.customers.listBalanceTransactions(stripeCustomerId, {
    limit,
  });
}

// --- Checkout ---

export async function createCheckoutSession(
  stripeCustomerId: string,
  successUrl: string,
  cancelUrl: string,
  reloadAmountCents: number
): Promise<Stripe.Checkout.Session> {
  const stripe = await getStripe();
  return stripe.checkout.sessions.create({
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
  });
}

// --- Payment (auto-reload) ---

export async function chargePaymentMethod(
  stripeCustomerId: string,
  paymentMethodId: string,
  amountCents: number,
  description: string
): Promise<Stripe.PaymentIntent> {
  const stripe = await getStripe();
  return stripe.paymentIntents.create({
    amount: amountCents,
    currency: "usd",
    customer: stripeCustomerId,
    payment_method: paymentMethodId,
    off_session: true,
    confirm: true,
    description,
    metadata: { type: "auto_reload" },
  });
}

// --- Webhook ---

export async function constructWebhookEvent(
  payload: Buffer,
  signature: string
): Promise<Stripe.Event> {
  if (!cachedWebhookSecret) {
    cachedWebhookSecret = await resolveAppKey("stripe-webhook");
  }
  const stripe = await getStripe();
  return stripe.webhooks.constructEvent(payload, signature, cachedWebhookSecret);
}
