/**
 * Reload flow: compose a Stripe PaymentIntent via stripe-service.
 *
 * stripe-service exposes only the Stripe-shape primitive (POST /v1/payment_intents).
 * Billing flattens Stripe's status enum into the {succeeded|failed} contract that
 * authorize/usage_apply consume.
 *
 * Picks an explicit `payment_method` via stripe-service `GET /v1/payment_methods`:
 * first an attached `card`, then a `link` PM as fallback. Both are chargeable
 * off_session — Stripe documents charging a saved `type:link` PM with
 * `off_session:true, confirm:true` exactly like a card
 * (https://docs.stripe.com/payments/link/save-and-reuse). A Checkout setup-mode flow
 * that offers card+link saves the PM as `type:link` for Link-enabled emails, so a
 * card-only pick used to throw for those orgs (Link-only) and silently disable reload.
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
 * Charge `amountCents` against the first chargeable PM attached to the org's customer
 * — a `card` if present, otherwise a `link` PM. Synchronous: Stripe processes the
 * charge inline because confirm:true off_session:true.
 *
 * Caller MUST pass an idempotency key to ensure retries collapse.
 *
 * Throws only if the customer has NO chargeable PM at all (no card and no link).
 * Caller's try/catch surfaces this as topup_triggered=false.
 */
export async function reloadViaPaymentIntent(
  identity: IdentityHeaders,
  amountCents: number,
  idempotencyKey: string
): Promise<ReloadOutcome> {
  const customer = await getCustomerByOrg(identity);
  const cards = await listPaymentMethods(identity, {
    customer: customer.id,
    type: "card",
  });
  let pm = cards.data[0];
  if (!pm) {
    const links = await listPaymentMethods(identity, {
      customer: customer.id,
      type: "link",
    });
    pm = links.data[0];
  }
  if (!pm) {
    throw new Error(
      "customer has no chargeable payment_method (card or link) attached for off_session reload"
    );
  }
  const pi = await createPaymentIntent(
    identity,
    {
      amount: amountCents,
      currency: RELOAD_CURRENCY,
      customer: customer.id,
      payment_method: pm.id,
      confirm: true,
      off_session: true,
    },
    idempotencyKey
  );
  return flattenStatus(pi);
}
