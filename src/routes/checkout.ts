import { recordCheckoutOpened } from "../lib/payment-alerts.js";
import { Router } from "express";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { CreateCheckoutRequestSchema } from "../schemas.js";
import {
  createCheckoutSession,
  sumSucceededTopupsForOrg,
} from "../lib/stripe-service-client.js";
import type { CheckoutSessionBody } from "../lib/stripe-service-client.js";
import { findOrCreateAccount, ensureOrgStripeCustomer } from "../lib/account.js";
import { decideCheckoutWelcomeNotice } from "../lib/welcome-completion.js";
import { settleFreeCreditPromises } from "../lib/free-credit-settlement.js";
import { traceEvent } from "../lib/trace-event.js";
import {
  decideOnboardingWelcomeDiscount,
  WelcomeDiscountRefusedError,
  type OnboardingWelcomeDiscount,
} from "../lib/onboarding-welcome-discount.js";

const CHECKOUT_PRODUCT_NAME = "Distribute credit top-up";
const CHECKOUT_CURRENCY = "usd";

import {
  assertTopupMinimum,
  getOrgFreeCreditOffer,
  TopupBelowMinimumError,
} from "../lib/free-credit-offer.js";
import { MATCH_FREE_CREDIT_OFFER } from "../db/schema.js";

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
    const applyWelcomeGift = parsed.data.apply_welcome_gift === true;

    // The welcome gift is a PAYMENT-mode deduction. Asking for it on a no-charge
    // card capture is a caller bug, not something to ignore.
    if (applyWelcomeGift && isSetup) {
      res.status(400).json({ error: "apply_welcome_gift applies to payment-mode checkout only" });
      return;
    }

    // Payment-mode (absent mode or "payment") AND embedded mode require an explicit
    // amount. Fail loud rather than defaulting — a charge with no amount is malformed.
    if (!isSetup && topup_amount_cents === undefined) {
      res.status(400).json({ error: "topup_amount_cents is required for payment-mode checkout" });
      return;
    }

    traceEvent(runId, { service: "billing-service", event: "checkout.start", data: { mode: isSetup ? "setup" : "payment", ui_mode: isEmbedded ? "embedded" : "hosted", topup_amount_cents } }, req.headers);

    await findOrCreateAccount(orgId, userId);

    // "We match your first $100" (lib/free-credit-offer): a top-up is at least $100,
    // and the $30 up-front gift is credit, never a coupon off the charge. Legacy
    // orgs: unchanged.
    if (!isSetup) {
      const offer = await getOrgFreeCreditOffer(orgId);
      try {
        assertTopupMinimum(offer, topup_amount_cents!);
      } catch (err) {
        if (err instanceof TopupBelowMinimumError) {
          res.status(400).json({ error: err.message, code: err.code, minimum_cents: err.minimumCents });
          return;
        }
        throw err;
      }
      if (applyWelcomeGift && offer === MATCH_FREE_CREDIT_OFFER) {
        res.status(409).json({
          error: "This organization's free credit is not a checkout discount",
          code: "welcome_discount_not_offered",
        });
        return;
      }
    }

    const identity = {
      "x-org-id": orgId,
      "x-user-id": userId,
      "x-run-id": runId,
      ...wfHeaders,
    };

    let session;
    let welcomeDiscount: OnboardingWelcomeDiscount | null = null;
    try {
      // A new org has a billing row but no Stripe customer yet: create it here,
      // idempotently — unless the org pays through another acquirer, which then
      // gets none (null) and stripe-service checks out on that acquirer's customer.
      const customer = await ensureOrgStripeCustomer(identity);
      const customerField = customer ? { customer: customer.id } : {};
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
          ...customerField,
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
        const welcomeNotice = await decideCheckoutWelcomeNotice(orgId);
        // Opt-in only: the caller hands billing the FULL budget and the deduction
        // with it. Without the flag nothing below changes (see
        // lib/onboarding-welcome-discount).
        if (applyWelcomeGift) {
          welcomeDiscount = await decideOnboardingWelcomeDiscount({
            orgId,
            budgetCents: topup_amount_cents!,
            paidTopupsCents,
          });
        }

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
          ...customerField,
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
        if (welcomeDiscount?.couponId) {
          body.discounts = [{ coupon: welcomeDiscount.couponId }];
        }
        if (welcomeNotice) {
          // Nothing comes off the price here: onboarding has already subtracted the
          // gift from the amount it sends (see lib/welcome-completion). This only
          // tells a MATCH-cohort buyer that part of their credit is still coming.
          body.custom_text = { submit: { message: welcomeNotice } };
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
      if (err instanceof WelcomeDiscountRefusedError) {
        res.status(409).json({ error: err.message, code: err.code, welcome_gift_cents: err.giftCents });
        return;
      }
      console.error("[billing-service] stripe-service createCheckoutSession failed:", err);
      res.status(502).json({ error: "Failed to create checkout session via stripe-service" });
      return;
    }

    // The acquirer must have charged exactly budget − gift. Anything else means the
    // coupon did not land as decided (wrong value, ignored): refuse to hand the
    // buyer a page that charges them the wrong amount.
    if (welcomeDiscount) {
      const due = welcomeDiscount.amountDueCents;
      const ok =
        session.presentation !== undefined
          ? session.amount === due
          : session.amount_total === due &&
            (session.total_details?.amount_discount ?? 0) === welcomeDiscount.giftCents;
      if (!ok) {
        console.error(
          `[billing-service] welcome discount not applied as decided for org ${orgId}: expected due=${due} gift=${welcomeDiscount.giftCents}, got amount=${session.amount} amount_total=${session.amount_total} discount=${session.total_details?.amount_discount}`
        );
        res.status(502).json({ error: "The welcome gift could not be applied to this checkout", code: "welcome_discount_not_applied" });
        return;
      }
    }
    const welcomeFields = welcomeDiscount
      ? { welcome_discount_cents: welcomeDiscount.giftCents, amount_due_cents: welcomeDiscount.amountDueCents }
      : {};

    // The payment this checkout may produce is alerted to the owner once it SUCCEEDS
    // (lib/payment-alerts); this records who opened it (staff's own payments are not
    // alerted) and marks the org for the fast scan. Never fails the checkout.
    if (!isSetup) {
      await recordCheckoutOpened(
        orgId,
        (req.headers["x-email"] as string | undefined) ?? null,
        welcomeDiscount ? welcomeDiscount.amountDueCents : topup_amount_cents ?? null
      );
    }

    traceEvent(runId, { service: "billing-service", event: "checkout.done", data: { session_id: session.session_id ?? session.id } }, req.headers);

    if (isEmbedded && session.presentation === "embedded_widget") {
      // An acquirer with no embedded Checkout Session (stripe-service v0.55.0)
      // takes the payment through a widget the page mounts itself. Relayed in
      // card_setup's own `embedded_widget` vocabulary, so the page switches on
      // `mode` for both surfaces. The token is a per-order PUBLIC id, not a key.
      // A widget answer without its widget cannot be mounted: fail loud here
      // rather than in the customer's browser.
      if (!session.widget) {
        console.error("[billing-service] stripe-service answered embedded_widget without a widget block");
        res.status(502).json({ error: "Failed to create checkout session via stripe-service" });
        return;
      }
      res.json({
        mode: "embedded_widget",
        script_url: session.widget.script_url,
        environment: session.widget.environment,
        token: session.widget.token,
        save_payment_method_for: session.widget.save_payment_method_for,
        amount: session.amount,
        currency: session.currency,
        session_id: session.id,
        ...welcomeFields,
      });
      return;
    }

    if (isEmbedded) {
      res.json({
        client_secret: session.client_secret,
        session_id: session.session_id,
        ...welcomeFields,
      });
      return;
    }

    res.json({
      url: session.url,
      session_id: session.session_id,
      ...welcomeFields,
    });
  } catch (err) {
    console.error("[billing-service] Error creating checkout session:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
