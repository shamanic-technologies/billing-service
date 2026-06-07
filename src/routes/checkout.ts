import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { CreateCheckoutRequestSchema } from "../schemas.js";
import { createCheckoutSession, getCustomerByOrg } from "../lib/stripe-service-client.js";
import type { CheckoutSessionBody } from "../lib/stripe-service-client.js";
import { findOrCreateAccount } from "../lib/account.js";
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
    const isSetup = parsed.data.mode === "setup";

    // Payment-mode (absent mode or "payment") requires an explicit amount. Fail loud
    // rather than defaulting — a payment checkout with no amount is a malformed request.
    if (!isSetup && topup_amount_cents === undefined) {
      res.status(400).json({ error: "topup_amount_cents is required for payment-mode checkout" });
      return;
    }

    traceEvent(runId, { service: "billing-service", event: "checkout.start", data: { mode: isSetup ? "setup" : "payment", topup_amount_cents } }, req.headers);

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
          success_url,
          cancel_url,
          customer: customer.id,
          metadata: { org_id: orgId },
        };
      } else {
        // payment mode — topup_amount_cents is guaranteed present by the 400 guard
        // above (non-setup + undefined already returned). The `!` reflects that proven
        // invariant; it is not a fallback.
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
          success_url,
          cancel_url,
          customer: customer.id,
          metadata: { org_id: orgId },
          payment_intent_data: {
            metadata: { org_id: orgId },
            setup_future_usage: "off_session",
          },
        };
      }
      session = await createCheckoutSession(identity, body);
    } catch (err) {
      console.error("[billing-service] stripe-service createCheckoutSession failed:", err);
      res.status(502).json({ error: "Failed to create checkout session via stripe-service" });
      return;
    }

    // Payment-mode persists the chosen top-up amount as the org's auto-topup amount.
    // Setup-mode is a pure card capture — it must NOT write any topup amount.
    if (!isSetup) {
      await db
        .update(billingAccounts)
        .set({
          topupAmountCents: topup_amount_cents,
          updatedAt: new Date(),
        })
        .where(eq(billingAccounts.orgId, orgId));
    }

    traceEvent(runId, { service: "billing-service", event: "checkout.done", data: { session_id: session.session_id } }, req.headers);

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
