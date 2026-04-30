import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, creditLedger } from "../db/schema.js";
import {
  constructWebhookEvent,
  retrievePaymentIntent,
} from "../lib/stripe.js";
import { fireAndForgetBalanceTxn } from "../lib/ledger.js";
import type Stripe from "stripe";

const router = Router();

// POST /v1/webhooks/stripe — Stripe webhook handler (fixed URL, org resolved from customer)
// NOTE: This route uses express.raw() body parser (mounted before express.json() in index.ts)
router.post("/v1/webhooks/stripe", async (req, res) => {
  try {
    const signature = req.headers["stripe-signature"] as string;
    if (!signature) {
      res.status(400).json({ error: "Missing stripe-signature header" });
      return;
    }

    let event: Stripe.Event;
    try {
      event = await constructWebhookEvent(req.body as Buffer, signature);
    } catch (err) {
      console.error("[billing-service] Webhook signature verification failed:", err);
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    switch (event.type) {
      case "checkout.session.completed": {
        await handleCheckoutCompleted(
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
          `[billing-service] Payment failed for customer ${pi.customer}: ${pi.last_payment_error?.message}`
        );
        break;
      }
      default:
        // Unhandled event type — acknowledge anyway
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error("[billing-service] Webhook processing error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const customerId = session.customer as string;
  if (!customerId) return;

  const [account] = await db
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.stripeCustomerId, customerId))
    .limit(1);

  if (!account) {
    console.error(
      `[billing-service] Checkout completed but no account found for customer ${customerId}`
    );
    return;
  }

  // Extract payment method from the PaymentIntent (not on the session directly)
  let paymentMethodId: string | null = null;
  const piId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id;
  if (piId) {
    const paymentIntent = await retrievePaymentIntent(piId);
    paymentMethodId =
      typeof paymentIntent.payment_method === "string"
        ? paymentIntent.payment_method
        : paymentIntent.payment_method?.id ?? null;
  }

  // Get reload amount from session metadata or account
  const reloadAmountCents = session.metadata?.reload_amount_cents
    ? parseInt(session.metadata.reload_amount_cents, 10)
    : account.reloadAmountCents;

  // Credit the balance with the reload amount and write to ledger
  if (reloadAmountCents) {
    const newBalance = account.creditBalanceCents + reloadAmountCents;

    // Insert reload ledger entry
    const [ledgerEntry] = await db
      .insert(creditLedger)
      .values({
        orgId: account.orgId,
        userId: "00000000-0000-0000-0000-000000000000",
        type: "credit",
        amountCents: reloadAmountCents,
        status: "confirmed",
        source: "reload",
        stripePaymentIntentId: piId ?? null,
        description: "Initial reload credit",
      })
      .returning();

    // Update account: set payment method, update balance
    await db
      .update(billingAccounts)
      .set({
        creditBalanceCents: newBalance,
        reloadAmountCents: reloadAmountCents ?? account.reloadAmountCents,
        ...(paymentMethodId ? { stripePaymentMethodId: paymentMethodId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.stripeCustomerId, customerId));

    // Fire-and-forget Stripe balance txn
    if (account.stripeCustomerId) {
      fireAndForgetBalanceTxn(
        account.orgId,
        "system",
        account.stripeCustomerId,
        -reloadAmountCents,
        "Initial reload credit",
        ledgerEntry.id
      );
    }
  } else {
    // No reload amount — just update payment method
    await db
      .update(billingAccounts)
      .set({
        ...(paymentMethodId ? { stripePaymentMethodId: paymentMethodId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.stripeCustomerId, customerId));
  }
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
