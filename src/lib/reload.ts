/**
 * Reload flow: compose a Stripe PaymentIntent via stripe-service.
 *
 * stripe-service exposes only the Stripe-shape primitive (POST /v1/payment_intents).
 * Billing flattens Stripe's status enum into the {succeeded|failed} contract that
 * authorize/usage_apply consume.
 */

import {
  createPaymentIntent,
  getCustomerByOrg,
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
 * Charge `amountCents` against the org's default payment method. Synchronous —
 * Stripe processes the charge inline because confirm:true off_session:true.
 *
 * Caller MUST pass an idempotency key to ensure retries collapse.
 */
export async function reloadViaPaymentIntent(
  identity: IdentityHeaders,
  amountCents: number,
  idempotencyKey: string
): Promise<ReloadOutcome> {
  const customer = await getCustomerByOrg(identity);
  const pi = await createPaymentIntent(
    identity,
    {
      amount: amountCents,
      currency: RELOAD_CURRENCY,
      customer: customer.id,
      confirm: true,
      off_session: true,
    },
    idempotencyKey
  );
  return flattenStatus(pi);
}
