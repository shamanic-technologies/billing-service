import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import {
  constructWebhookEvent,
  createBalanceTransaction,
} from "../lib/stripe.js";
import type Stripe from "stripe";

const router = Router();

// POST /v1/webhooks/stripe/:appId — Stripe webhook handler (per-app)
// NOTE: This route uses express.raw() body parser (mounted before express.json() in index.ts)
router.post("/v1/webhooks/stripe/:appId", async (req, res) => {
  try {
    const appId = req.params.appId;
    const signature = req.headers["stripe-signature"] as string;
    if (!signature) {
      res.status(400).json({ error: "Missing stripe-signature header" });
      return;
    }

    let event: Stripe.Event;
    try {
      event = await constructWebhookEvent(appId, req.body as Buffer, signature);
    } catch (err) {
      console.error("Webhook signature verification failed:", err);
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    switch (event.type) {
      case "checkout.session.completed": {
        await handleCheckoutCompleted(
          appId,
          event.data.object as Stripe.Checkout.Session
        );
        break;
      }
      case "payment_intent.succeeded": {
        await handlePaymentSucceeded(
          event.data.object as Stripe.PaymentIntent
        );
        break;
      }
      case "payment_intent.payment_failed": {
        const pi = event.data.object as Stripe.PaymentIntent;
        console.error(
          `Payment failed for customer ${pi.customer}: ${pi.last_payment_error?.message}`
        );
        break;
      }
      default:
        // Unhandled event type — acknowledge anyway
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

async function handleCheckoutCompleted(appId: string, session: Stripe.Checkout.Session) {
  const customerId = session.customer as string;
  if (!customerId) return;

  const [account] = await db
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.stripeCustomerId, customerId))
    .limit(1);

  if (!account) {
    console.error(
      `Checkout completed but no account found for customer ${customerId}`
    );
    return;
  }

  // Extract payment method from the session
  const sessionAny = session as unknown as Record<string, unknown>;
  const paymentMethodId = (sessionAny.payment_method as string) ?? null;

  // Get reload amount from session metadata or account
  const reloadAmountCents = session.metadata?.reload_amount_cents
    ? parseInt(session.metadata.reload_amount_cents, 10)
    : account.reloadAmountCents;

  // Credit the balance with the reload amount
  if (reloadAmountCents && account.stripeCustomerId) {
    await createBalanceTransaction(
      appId,
      account.stripeCustomerId,
      -reloadAmountCents,
      "Initial reload credit"
    );
  }

  // Update account: set payment method, switch to PAYG, update balance
  const newBalance = account.creditBalanceCents + (reloadAmountCents ?? 0);

  await db
    .update(billingAccounts)
    .set({
      billingMode: "payg",
      creditBalanceCents: newBalance,
      reloadAmountCents: reloadAmountCents ?? account.reloadAmountCents,
      ...(paymentMethodId ? { stripePaymentMethodId: paymentMethodId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(billingAccounts.stripeCustomerId, customerId));
}

async function handlePaymentSucceeded(paymentIntent: Stripe.PaymentIntent) {
  // Only process auto-reload payment intents
  if (paymentIntent.metadata?.type !== "auto_reload") return;

  const customerId = paymentIntent.customer as string;
  if (!customerId) return;

  const [account] = await db
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.stripeCustomerId, customerId))
    .limit(1);

  if (!account) return;

  // Update the payment method if it changed
  const pmId =
    typeof paymentIntent.payment_method === "string"
      ? paymentIntent.payment_method
      : paymentIntent.payment_method?.id;

  if (pmId && pmId !== account.stripePaymentMethodId) {
    await db
      .update(billingAccounts)
      .set({
        stripePaymentMethodId: pmId,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.stripeCustomerId, customerId));
  }
}

export default router;
