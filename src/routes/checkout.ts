import { Router } from "express";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { CreateCheckoutRequestSchema } from "../schemas.js";
import {
  createCheckoutSession,
  getCustomerByOrg,
  sumSucceededTopupsForOrg,
} from "../lib/stripe-service-client.js";
import type { CheckoutSessionBody } from "../lib/stripe-service-client.js";
import { findOrCreateAccount } from "../lib/account.js";
import { decideCheckoutWelcomeOffer } from "../lib/welcome-completion.js";
import { settleFreeCreditPromises } from "../lib/free-credit-settlement.js";
import { traceEvent } from "../lib/trace-event.js";

const CHECKOUT_PRODUCT_NAME = "Distribute credit top-up";
const CHECKOUT_CURRENCY = "usd";

const router = Router();

// POST /v1/checkout-sessions — create Stripe Checkout session via stripe-service.
router.post("/v1/checkout-sessions", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));

    const parsed = CreateCheckoutRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { success_url, cancel_url, topup_amount_cents } = parsed.data;
    const isEmbedded = parsed.data.ui_mode === "embedded";
    // Embedded is payment-only (always charges topup_amount_cents); hosted "setup" is
    // a no-charge card capture. Embedded therefore never takes the setup branch.
    const isSetup = !isEmbedded && parsed.data.mode === "setup";

    // Payment-mode (absent mode or "payment") AND embedded mode require an explicit
    // amount. Fail loud rather than defaulting — a charge with no amount is malformed.
    if (!isSetup && topup_amount_cents === undefined) {
      res.status(400).json({ error: "topup_amount_cents is required for payment-mode checkout" });
      return;
    }

    traceEvent(runId, { service: "billing-service", event: "checkout.start", data: { mode: isSetup ? "setup" : "payment", ui_mode: isEmbedded ? "embedded" : "hosted", topup_amount_cents } }, req.headers);

    await findOrCreateAccount(orgId, userId, wfHeaders);

    const identity = {
      "x-org-id": orgId,
      "x-user-id": userId,
      "x-run-id": runId,
      ...wfHeaders,
    };

    let session;
    try {
      const customer = await getCustomerByOrg(identity);
      let body: CheckoutSessionBody;
      if (isSetup) {
        // No-charge card capture: saves a reusable off-session card (Stripe
        // setup-mode SetupIntent defaults to usage=off_session) so the org can
        // enable auto-topup later. No line_items, no payment_intent_data.
        body = {
          mode: "setup",
          currency: CHECKOUT_CURRENCY,
          success_url,
          cancel_url,
          customer: customer.id,
          metadata: { org_id: orgId },
        };
      } else {
        // Free-credit offer for THIS checkout. Needs the org's cumulative paid
        // topups: the discount may only ever land on an org that has NEVER paid,
        // otherwise every later top-up would silently get the free credits off
        // forever. Settling first also covers an org whose earlier payment already
        // crossed its trigger but was not yet settled, so the notice/discount
        // decision reads a fresh ledger — including the grandfather resolution,
        // which is what stops the "the rest is coming" notice being shown to an org
        // that had already crossed the trigger before launch and is owed nothing.
        // Both fail loud (the catch below → 502): the price a buyer is shown must
        // be decided against the real ledger, never against a stale read of it.
        const paidTopupsCents = await sumSucceededTopupsForOrg(orgId);
        await settleFreeCreditPromises(orgId, paidTopupsCents);
        const welcome = await decideCheckoutWelcomeOffer(orgId, paidTopupsCents);

        // payment mode (hosted or embedded) — topup_amount_cents is guaranteed present
        // by the 400 guard above (non-setup + undefined already returned). The `!`
        // reflects that proven invariant; it is not a fallback.
        body = {
          mode: "payment",
          line_items: [
            {
              price_data: {
                currency: CHECKOUT_CURRENCY,
                product_data: { name: CHECKOUT_PRODUCT_NAME },
                unit_amount: topup_amount_cents!,
              },
              quantity: 1,
            },
          ],
          customer: customer.id,
          metadata: { org_id: orgId },
          payment_intent_data: {
            metadata: { org_id: orgId },
            setup_future_usage: "off_session",
          },
          // Auto-create a finalized Stripe Invoice + PDF for the top-up charge so it
          // shows up in the customer portal's "Invoice history" tab. Payment mode only;
          // the off-session auto-topup charges (customer_balance usage_apply) are raw
          // PaymentIntents and are NOT invoiced by this — separate future work.
          invoice_creation: { enabled: true },
        };
        if (welcome.couponId) {
          // Show the free credits coming OFF the price. The org has already been
          // gifted its full entitlement (that is the gate), so this discounts the
          // cash side of a gift the ledger has already recorded — the buyer pays
          // (budget - entitlement) and holds (budget) of balance. It is not an
          // advance: nothing here is earned by paying. See lib/welcome-completion.
          body.discounts = [{ coupon: welcome.couponId }];
        } else if (welcome.noticeMessage) {
          // Nothing to take off the price, but part of the gift is still coming:
          // tell the buyer so, at the moment of payment. The figures quoted are
          // this org's own offer.
          body.custom_text = { submit: { message: welcome.noticeMessage } };
        }
        if (isEmbedded) {
          // Embedded Checkout: mounted in an in-app modal iframe. No redirect URLs —
          // Stripe keeps the flow in-app (redirect_on_completion:"never") and returns a
          // client_secret instead of a hosted `url`. Same charge + card-save accounting;
          // credit lands via the same checkout.session.completed webhook.
          body.ui_mode = "embedded";
          body.redirect_on_completion = "never";
        } else {
          body.success_url = success_url;
          body.cancel_url = cancel_url;
          // NOTE: `allow_promotion_codes` is deliberately NOT set. Stripe's native
          // "Add promotion code" entry was enabled for a single journalist comp; that
          // is done, and it is mutually exclusive with the pre-applied welcome
          // discount above. Do not re-add it.
        }
      }
      session = await createCheckoutSession(identity, body);
    } catch (err) {
      console.error("[billing-service] stripe-service createCheckoutSession failed:", err);
      res.status(502).json({ error: "Failed to create checkout session via stripe-service" });
      return;
    }

    traceEvent(runId, { service: "billing-service", event: "checkout.done", data: { session_id: session.session_id } }, req.headers);

    if (isEmbedded) {
      res.json({
        client_secret: session.client_secret,
        session_id: session.session_id,
      });
      return;
    }

    res.json({
      url: session.url,
      session_id: session.session_id,
    });
  } catch (err) {
    console.error("[billing-service] Error creating checkout session:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
