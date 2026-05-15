import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, customerBalanceTransactions } from "../db/schema.js";
import {
  constructWebhookEvent,
  retrievePaymentIntent,
} from "../lib/stripe.js";
import { addCents } from "../lib/cents.js";
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

  // Topup amount lives in session metadata (Stripe-aligned key) or on the account
  // from a previous setup. Pre-v3 metadata key `reload_amount_cents` is still
  // accepted for in-flight sessions; new sessions emit `topup_amount_cents`.
  const topupRaw =
    session.metadata?.topup_amount_cents ??
    session.metadata?.reload_amount_cents;
  const topupAmountCents = topupRaw ? parseInt(topupRaw, 10) : account.topupAmountCents;

  if (topupAmountCents) {
    const oldBalance = account.balanceCents;
    const newBalance = addCents(oldBalance, String(topupAmountCents));

    // Insert payment grant entry — signed negative (credit).
    await db
      .insert(customerBalanceTransactions)
      .values({
        orgId: account.orgId,
        userId: "00000000-0000-0000-0000-000000000000",
        type: "payment",
        amountCents: String(-topupAmountCents),
        status: "succeeded",
        stripePaymentIntentId: piId ?? null,
        description: "Initial top-up",
      });

    await db
      .update(billingAccounts)
      .set({
        balanceCents: newBalance,
        topupAmountCents: topupAmountCents ?? account.topupAmountCents,
        ...(paymentMethodId ? { stripePaymentMethodId: paymentMethodId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.stripeCustomerId, customerId));
  } else {
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
  // Only process auto-topup payment intents (legacy metadata key: auto_reload)
  const piType = paymentIntent.metadata?.type;
  if (piType !== "auto_topup" && piType !== "auto_reload") return;

  const customerId = paymentIntent.customer as string;
  if (!customerId) return;

  const [account] = await db
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.stripeCustomerId, customerId))
    .limit(1);

  if (!account) return;

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
