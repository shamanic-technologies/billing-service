import { Router, type Response } from "express";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { findOrCreateAccount } from "../lib/account.js";
import { computeBalance } from "../lib/balance.js";
import { getPaymentMode } from "../lib/payment-mode.js";
import {
  cancelSubscription,
  isValidMonthlyAmount,
  raiseSubscriptionAmount,
  resumeSubscription,
  settleOrgSubscription,
  startSubscriptionCheckout,
  subscriptionWire,
  SubscriptionRefused,
} from "../lib/subscription.js";
import type { OrgSubscription } from "../lib/subscription-client.js";
import {
  RaiseSubscriptionRequestSchema,
  SubscriptionCheckoutRequestSchema,
} from "../schemas.js";

/**
 * SUBSCRIPTION — see lib/subscription for the model. Customer routes carry the org
 * headers (via the api-service gateway); the staff read takes the org in the path.
 */
const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(res: Response, err: SubscriptionRefused): void {
  res.status(err.status).json({ error: err.message, code: err.code });
}

/** The subscription read: settles first, so a just-completed checkout lands now. */
async function readSubscription(orgId: string) {
  const settled = await settleOrgSubscription(orgId);
  const snapshot = await computeBalance(orgId);
  return {
    org_id: orgId,
    payment_mode: settled.paymentMode,
    subscription: subscriptionWire(settled.subscription),
    credits_remaining_cents: snapshot.balanceCents,
    trial_grant_cents: settled.trialGrantCents,
  };
}

async function actionResponse(orgId: string, sub: OrgSubscription) {
  const snapshot = await computeBalance(orgId);
  return {
    org_id: orgId,
    subscription: subscriptionWire(sub),
    credits_remaining_cents: snapshot.balanceCents,
  };
}

router.get("/v1/accounts/subscription", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  try {
    await findOrCreateAccount(orgId, req.headers["x-user-id"] as string);
    res.json(await readSubscription(orgId));
  } catch (err) {
    console.error(`[billing-service] subscription read failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to read the subscription" });
  }
});

router.post("/v1/accounts/subscription/checkout_session", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  const userId = req.headers["x-user-id"] as string;
  const parsed = SubscriptionCheckoutRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const uiMode = parsed.data.ui_mode ?? "embedded";
  if (uiMode === "hosted" && (!parsed.data.success_url || !parsed.data.cancel_url)) {
    res.status(400).json({ error: "success_url and cancel_url are required for hosted checkout" });
    return;
  }
  try {
    await findOrCreateAccount(orgId, userId);
    const identity = {
      "x-org-id": orgId,
      "x-user-id": userId,
      "x-run-id": req.headers["x-run-id"] as string,
      ...forwardWorkflowHeaders(getWorkflowHeaders(req)),
    };
    const session = await startSubscriptionCheckout({
      orgId,
      identity,
      uiMode,
      successUrl: parsed.data.success_url,
      cancelUrl: parsed.data.cancel_url,
    });
    res.json({
      mode: uiMode,
      session_id: session.sessionId,
      client_secret: session.clientSecret,
      url: session.url,
      trial_days: session.trialDays,
      monthly_amount_cents: session.monthlyAmountCents,
      currency: "usd",
    });
  } catch (err) {
    if (err instanceof SubscriptionRefused) return refuse(res, err);
    console.error(`[billing-service] subscription checkout failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to create the subscription checkout" });
  }
});

router.patch("/v1/accounts/subscription", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  const parsed = RaiseSubscriptionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!isValidMonthlyAmount(parsed.data.monthly_amount_cents)) {
    res.status(400).json({
      error: "monthly_amount_cents must be 9900 + a multiple of 10000 ($99, $199, $299, ...)",
    });
    return;
  }
  try {
    const sub = await raiseSubscriptionAmount(orgId, parsed.data.monthly_amount_cents);
    res.json(await actionResponse(orgId, sub));
  } catch (err) {
    if (err instanceof SubscriptionRefused) return refuse(res, err);
    console.error(`[billing-service] subscription raise failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to change the subscription amount" });
  }
});

router.post("/v1/accounts/subscription/cancel", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  try {
    res.json(await actionResponse(orgId, await cancelSubscription(orgId)));
  } catch (err) {
    if (err instanceof SubscriptionRefused) return refuse(res, err);
    console.error(`[billing-service] subscription cancel failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to cancel the subscription" });
  }
});

router.post("/v1/accounts/subscription/resume", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  try {
    res.json(await actionResponse(orgId, await resumeSubscription(orgId)));
  } catch (err) {
    if (err instanceof SubscriptionRefused) return refuse(res, err);
    console.error(`[billing-service] subscription resume failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to resume the subscription" });
  }
});

router.get("/internal/accounts/by-org/:orgId/subscription", async (req, res) => {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a valid UUID" });
    return;
  }
  try {
    if ((await getPaymentMode(orgId)) === null) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }
    res.json(await readSubscription(orgId));
  } catch (err) {
    console.error(`[billing-service] subscription read failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to read the subscription" });
  }
});

export default router;
