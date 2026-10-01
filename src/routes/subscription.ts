import { Router, type Response } from "express";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { findOrCreateAccount } from "../lib/account.js";
import { computeBalance } from "../lib/balance.js";
import { getPaymentMode } from "../lib/payment-mode.js";
import { getSavedPaymentMethod } from "../lib/stripe-service-client.js";
import {
  cancelSubscription,
  changeSubscriptionAmount,
  isValidMonthlyAmount,
  requestSubscription,
  resumeSubscription,
  settleOrgSubscription,
  startSubscription,
  subscriptionWire,
  SubscriptionRefused,
  SUBSCRIPTION_BASE_MONTHLY_CENTS,
} from "../lib/subscription.js";
import { sumSubscriptionExpiriesForOrg } from "../lib/subscription-expiries.js";
import type { Subscription } from "../db/schema.js";
import {
  ChangeSubscriptionAmountRequestSchema,
  StartSubscriptionRequestSchema,
  SubscriptionCheckoutRequestSchema,
} from "../schemas.js";

/**
 * SUBSCRIPTION — see lib/subscription for the model. Customer routes carry the org
 * headers (via the api-service gateway); the staff read takes the org in the path.
 */
const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LADDER_MESSAGE = "monthly_amount_cents must be 9900 + a multiple of 10000 ($99, $199, $299, ...)";

function refuse(res: Response, err: SubscriptionRefused): void {
  res.status(err.status).json({ error: err.message, code: err.code });
}

async function hasSavedCard(orgId: string): Promise<boolean> {
  return (await getSavedPaymentMethod(orgId)).saved;
}

/** The subscription read: settles first (starts / renews / expires as due). */
async function readSubscription(orgId: string) {
  const settled = await settleOrgSubscription(orgId);
  const [snapshot, mode, expired, saved] = await Promise.all([
    computeBalance(orgId),
    getPaymentMode(orgId),
    sumSubscriptionExpiriesForOrg(orgId),
    hasSavedCard(orgId),
  ]);
  return {
    org_id: orgId,
    payment_mode: mode,
    subscription: subscriptionWire(settled.subscription, saved),
    credits_remaining_cents: snapshot.balanceCents,
    trial_grant_cents: settled.trialGrantCents,
    expired_cents: expired,
  };
}

async function actionResponse(orgId: string, sub: Subscription) {
  const [snapshot, saved] = await Promise.all([computeBalance(orgId), hasSavedCard(orgId)]);
  return {
    org_id: orgId,
    subscription: subscriptionWire(sub, saved),
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
  const amount = parsed.data.monthly_amount_cents ?? SUBSCRIPTION_BASE_MONTHLY_CENTS;
  if (!isValidMonthlyAmount(amount)) {
    res.status(400).json({ error: LADDER_MESSAGE });
    return;
  }
  const uiMode = parsed.data.ui_mode ?? "embedded";
  if (uiMode === "hosted" && !parsed.data.return_url) {
    res.status(400).json({ error: "return_url is required for a hosted card form" });
    return;
  }
  try {
    await findOrCreateAccount(orgId, userId);
    const request = await requestSubscription({
      orgId,
      identity: {
        "x-org-id": orgId,
        "x-user-id": userId,
        "x-run-id": req.headers["x-run-id"] as string,
        ...forwardWorkflowHeaders(getWorkflowHeaders(req)),
      },
      monthlyAmountCents: amount,
      uiMode,
      returnUrl: parsed.data.return_url,
    });
    res.json({
      monthly_amount_cents: request.monthlyAmountCents,
      currency: "usd",
      trial_days: request.trialDays,
      card_required: request.cardRequired,
      card_setup: request.cardSetup,
    });
  } catch (err) {
    if (err instanceof SubscriptionRefused) return refuse(res, err);
    console.error(`[billing-service] subscription checkout failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to prepare the subscription" });
  }
});

router.post("/v1/accounts/subscription/start", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  const userId = req.headers["x-user-id"] as string;
  const parsed = StartSubscriptionRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const amount = parsed.data.monthly_amount_cents;
  if (amount !== undefined && !isValidMonthlyAmount(amount)) {
    res.status(400).json({ error: LADDER_MESSAGE });
    return;
  }
  try {
    await findOrCreateAccount(orgId, userId);
    await startSubscription({ orgId, userId, monthlyAmountCents: amount });
    res.json(await readSubscription(orgId));
  } catch (err) {
    if (err instanceof SubscriptionRefused) return refuse(res, err);
    console.error(`[billing-service] subscription start failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to start the subscription" });
  }
});

router.patch("/v1/accounts/subscription", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  const parsed = ChangeSubscriptionAmountRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!isValidMonthlyAmount(parsed.data.monthly_amount_cents)) {
    res.status(400).json({ error: LADDER_MESSAGE });
    return;
  }
  try {
    const sub = await changeSubscriptionAmount(orgId, parsed.data.monthly_amount_cents);
    res.json(await actionResponse(orgId, sub));
  } catch (err) {
    if (err instanceof SubscriptionRefused) return refuse(res, err);
    console.error(`[billing-service] subscription amount change failed for org ${orgId}:`, err);
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
