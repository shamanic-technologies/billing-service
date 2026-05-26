/**
 * Reload flow: compose a Stripe PaymentIntent via stripe-service.
 *
 * stripe-service exposes only the Stripe-shape primitive (POST /v1/payment_intents).
 * Billing flattens Stripe's status enum into the {succeeded|failed} contract that
 * authorize/usage_apply consume.
 *
 * Picks an explicit card `payment_method` via stripe-service `GET /v1/payment_methods`
 * — Stripe refuses to charge Link / wallet PMs in off_session mode via the
 * `customer.invoice_settings.default_payment_method` fallback.
 */

import {
  createPaymentIntent,
  getCustomerByOrg,
  listPaymentMethods,
  type IdentityHeaders,
  type StripePaymentIntent,
} from "./stripe-service-client.js";
import type { ReloadOutcome } from "./reload-coalescer.js";

const RELOAD_CURRENCY = "usd";

function flattenStatus(pi: StripePaymentIntent): ReloadOutcome {
  if (pi.status === "succeeded") {
    return { status: "succeeded", payment_intent_id: pi.id };
  }
  const reason = pi.last_payment_error?.message ?? `pi.status=${pi.status}`;
  return { status: "failed", payment_intent_id: pi.id, failure_reason: reason };
}

/**
 * Charge `amountCents` against the first card PM attached to the org's customer.
 * Synchronous — Stripe processes the charge inline because confirm:true off_session:true.
 *
 * Caller MUST pass an idempotency key to ensure retries collapse.
 *
 * Throws if the customer has no attached card PM (Link-only / no PM at all).
 * Caller's try/catch surfaces this as topup_triggered=false.
 */
export async function reloadViaPaymentIntent(
  identity: IdentityHeaders,
  amountCents: number,
  idempotencyKey: string
): Promise<ReloadOutcome> {
  const customer = await getCustomerByOrg(identity);
  const methods = await listPaymentMethods(identity, {
    customer: customer.id,
    type: "card",
  });
  const cardPm = methods.data[0];
  if (!cardPm) {
    throw new Error("customer has no card payment_method attached for off_session reload");
  }
  const pi = await createPaymentIntent(
    identity,
    {
      amount: amountCents,
      currency: RELOAD_CURRENCY,
      customer: customer.id,
      payment_method: cardPm.id,
      confirm: true,
      off_session: true,
    },
    idempotencyKey
  );
  return flattenStatus(pi);
}
