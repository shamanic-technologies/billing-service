/**
 * Off-session auto-topup reload: charge the org's stored card so it produces a
 * FINALIZED, PAID Stripe INVOICE (hosted invoice + PDF in the customer's billing
 * portal), not a bare uninvoiced PaymentIntent.
 *
 * Interactive Checkout top-ups already invoice (checkout.ts invoice_creation).
 * This closes the gap for the AUTOMATIC path: stripe-service exposes
 * `POST /internal/invoices/by-org/{orgId}` (stripe-service#89) which drives Stripe
 * draft-invoice → line-item → finalize → pay-off_session and returns the paid
 * Invoice. billing flattens Stripe's invoice status into the {succeeded|failed}
 * ReloadOutcome that authorize / usage_apply / month-end-sweep / wallet_setup
 * consume — the SAME contract the former `createPaymentIntent` reload returned, so
 * no caller changes shape.
 *
 * Payment method: an explicit `card` PM is resolved billing-side (first card, then
 * a `link` fallback) and passed to stripe-service, mirroring the former reload's
 * pick order. Both are chargeable off_session — Stripe documents charging a saved
 * `type:link` PM with `off_session:true` exactly like a card
 * (https://docs.stripe.com/payments/link/save-and-reuse). Passing an explicit id
 * avoids the customer-default PM, which may be a Link/wallet PM Stripe refuses to
 * charge off_session.
 *
 * Accounting: the invoice's underlying PaymentIntent is snapshotted into
 * stripe-service's mirror on pay, so billing's `sumSucceededTopups*` counts this
 * top-up as a paid topup identically to the former bare-PI reload — no double- or
 * under-count of credited/balance.
 */

import {
  createOffSessionInvoiceForOrg,
  getCustomerByOrg,
  listPaymentMethods,
  type IdentityHeaders,
  type StripeInvoice,
} from "./stripe-service-client.js";
import type { ReloadOutcome } from "./reload-coalescer.js";

const RELOAD_CURRENCY = "usd";
/** Invoice line-item + invoice description (min length 1 required by stripe-service). */
const RELOAD_DESCRIPTION = "Distribute credit top-up";

function flattenInvoiceStatus(invoice: StripeInvoice): ReloadOutcome {
  const paymentIntentId =
    typeof invoice.payment_intent === "string"
      ? invoice.payment_intent
      : invoice.payment_intent?.id;
  if (invoice.status === "paid" || invoice.paid === true) {
    return { status: "succeeded", payment_intent_id: paymentIntentId };
  }
  // stripe-service throws (non-2xx) on a declined off_session charge, so this
  // branch is defensive — a 200 with a non-paid status is still a failed reload.
  return {
    status: "failed",
    payment_intent_id: paymentIntentId,
    failure_reason: `invoice.status=${invoice.status ?? "unknown"}`,
  };
}

/**
 * Charge `amountCents` off_session against the org's first chargeable PM (card,
 * then link) via the stripe-service off-session INVOICE endpoint, producing a
 * finalized paid invoice. Synchronous: stripe-service finalizes + pays inline and
 * returns the paid Invoice.
 *
 * `identity` must carry `x-org-id` (the org whose customer is charged) and, for the
 * PM lookup, `x-user-id` (the `/v1/payment_methods` read requires it — real user,
 * or the sweep/internal sentinel). The invoice charge itself is user-less (orgId is
 * in the path).
 *
 * Caller MUST pass an idempotency key so retries collapse (stripe-service derives
 * per-Stripe-step keys from it — no duplicate invoice, no double charge).
 *
 * Throws if the customer has NO chargeable PM (no card and no link), or if the
 * off_session charge is declined / stripe-service errors (fail-loud). Caller's
 * try/catch surfaces this as topup_triggered=false / a 502.
 */
export async function reloadViaInvoice(
  identity: IdentityHeaders,
  amountCents: number,
  idempotencyKey: string,
  metadata?: Record<string, string>
): Promise<ReloadOutcome> {
  const orgId = identity["x-org-id"];
  if (!orgId) {
    throw new Error("reloadViaInvoice: identity is missing x-org-id");
  }
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
  const invoice = await createOffSessionInvoiceForOrg(
    orgId,
    {
      amount: amountCents,
      currency: RELOAD_CURRENCY,
      description: RELOAD_DESCRIPTION,
      payment_method: pm.id,
      metadata,
    },
    idempotencyKey
  );
  return flattenInvoiceStatus(invoice);
}
