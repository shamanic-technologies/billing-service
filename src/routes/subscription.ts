import { Router, type Response } from "express";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { findOrCreateAccount } from "../lib/account.js";
import { computeBalance } from "../lib/balance.js";
import { getPaymentMode } from "../lib/payment-mode.js";
import { getSavedPaymentMethod } from "../lib/stripe-service-client.js";
import {
  cancelSubscription,
  changeSubscriptionAmount,
  pauseSubscription,
  unpauseSubscription,
  getOrgSendingStopped,
  monthlyAmountRefusal,
  listAllSubscriptions,
  requestSubscription,
  startPlanForOffer,
  resumeSubscription,
  settleOrgSubscription,
  startSubscriptionNow,
  startSubscription,
  subscriptionWire,
  SubscriptionRefused,
  SUBSCRIPTION_BASE_MONTHLY_CENTS,
} from "../lib/subscription.js";
import { sumSubscriptionExpiriesForOrg } from "../lib/subscription-expiries.js";
import { attributeUnassignedPlan } from "../lib/subscription-plans.js";
import type { Subscription } from "../db/schema.js";
import {
  ChangeSubscriptionAmountRequestSchema,
  PauseSubscriptionRequestSchema,
  StartPlanRequestSchema,
  StartSubscriptionRequestSchema,
  SubscriptionCheckoutRequestSchema,
} from "../schemas.js";

/**
 * SUBSCRIPTION — see lib/subscription for the model. Customer routes carry the org
 * headers (via the api-service gateway); the staff read takes the org in the path.
 */
const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 400 {error, code} when a monthly amount is refused; true when it was. */
function refuseAmount(res: Response, cents: number): boolean {
  const code = monthlyAmountRefusal(cents);
  if (!code) return false;
  res.status(400).json({
    error:
      code === "amount_below_minimum"
        ? "monthly_amount_cents must be at least 2900 ($29)"
        : "monthly_amount_cents must be whole dollars (a multiple of 100)",
    code,
  });
  return true;
}

/** Whether this org still sends, for the dashboard ("sending has stopped"). */
async function sendingFields(orgId: string) {
  const reason = await getOrgSendingStopped(orgId);
  return { sending_stopped: reason !== null, sending_stopped_reason: reason };
}

function refuse(res: Response, err: SubscriptionRefused): void {
  res.status(err.status).json({ error: err.message, code: err.code });
}

async function hasSavedCard(orgId: string): Promise<boolean> {
  return (await getSavedPaymentMethod(orgId)).saved;
}

/** The subscription read: settles first (starts / renews / expires as due). */
async function readSubscription(orgId: string) {
  const settled = await settleOrgSubscription(orgId);
  const [snapshot, mode, expired, saved, sending] = await Promise.all([
    computeBalance(orgId),
    getPaymentMode(orgId),
    sumSubscriptionExpiriesForOrg(orgId),
    hasSavedCard(orgId),
    sendingFields(orgId),
  ]);
  return {
    ...sending,
    org_id: orgId,
    payment_mode: mode,
    subscription: subscriptionWire(settled.subscription, saved),
    credits_remaining_cents: snapshot.balanceCents,
    trial_grant_cents: settled.trialGrantCents,
    expired_cents: expired,
  };
}

async function actionResponse(orgId: string, sub: Subscription) {
  const [snapshot, saved, sending] = await Promise.all([
    computeBalance(orgId),
    hasSavedCard(orgId),
    sendingFields(orgId),
  ]);
  return {
    ...sending,
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
  if (refuseAmount(res, amount)) return;
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
  if (amount !== undefined && refuseAmount(res, amount)) return;
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
  if (refuseAmount(res, parsed.data.monthly_amount_cents)) return;
  try {
    const sub = parsed.data.start_now
      ? await startSubscriptionNow(orgId, parsed.data.monthly_amount_cents)
      : await changeSubscriptionAmount(orgId, parsed.data.monthly_amount_cents);
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

// --- pause / unpause (the primary plan) --------------------------------------

router.post("/v1/accounts/subscription/pause", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  const parsed = PauseSubscriptionRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "months must be 1, 2 or 3" });
    return;
  }
  try {
    res.json(await actionResponse(orgId, await pauseSubscription(orgId, parsed.data.months)));
  } catch (err) {
    if (err instanceof SubscriptionRefused) return refuse(res, err);
    console.error(`[billing-service] subscription pause failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to pause the subscription" });
  }
});

router.post("/v1/accounts/subscription/unpause", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  try {
    res.json(await actionResponse(orgId, await unpauseSubscription(orgId)));
  } catch (err) {
    if (err instanceof SubscriptionRefused) return refuse(res, err);
    console.error(`[billing-service] subscription unpause failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to unpause the subscription" });
  }
});

// --- plans per brand x offer ------------------------------------------------

/** Live plans first (oldest first), then ended ones (newest first). */
function orderPlans(plans: Subscription[]): Subscription[] {
  const live = plans.filter((p) => p.status !== "canceled");
  const ended = plans.filter((p) => p.status === "canceled").reverse();
  return [...live, ...ended];
}

router.get("/v1/accounts/subscriptions", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  try {
    await findOrCreateAccount(orgId, req.headers["x-user-id"] as string);
    await settleOrgSubscription(orgId);
    await attributeUnassignedPlan(orgId);
    const [plans, snapshot, mode, expired, saved, sending] = await Promise.all([
      listAllSubscriptions(orgId),
      computeBalance(orgId),
      getPaymentMode(orgId),
      sumSubscriptionExpiriesForOrg(orgId),
      hasSavedCard(orgId),
      sendingFields(orgId),
    ]);
    res.json({
      ...sending,
      org_id: orgId,
      payment_mode: mode,
      subscriptions: orderPlans(plans).map((p) => subscriptionWire(p, saved)),
      credits_remaining_cents: snapshot.balanceCents,
      expired_cents: expired,
    });
  } catch (err) {
    console.error(`[billing-service] plan list failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to read the plans" });
  }
});

router.post("/v1/accounts/subscriptions", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  const userId = req.headers["x-user-id"] as string;
  const parsed = StartPlanRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (refuseAmount(res, parsed.data.monthly_amount_cents)) return;
  try {
    await findOrCreateAccount(orgId, userId);
    const sub = await startPlanForOffer({
      orgId,
      userId,
      brandId: parsed.data.brand_id,
      offerId: parsed.data.offer_id,
      monthlyAmountCents: parsed.data.monthly_amount_cents,
    });
    res.status(201).json(await actionResponse(orgId, sub));
  } catch (err) {
    if (err instanceof SubscriptionRefused) return refuse(res, err);
    console.error(`[billing-service] plan start failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to start the plan" });
  }
});

function planId(req: { params: Record<string, string> }, res: Response): string | null {
  const id = req.params.subscriptionId;
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "This organization has no such plan.", code: "no_subscription" });
    return null;
  }
  return id.toLowerCase();
}

router.patch("/v1/accounts/subscriptions/:subscriptionId", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  const id = planId(req, res);
  if (!id) return;
  const parsed = ChangeSubscriptionAmountRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (refuseAmount(res, parsed.data.monthly_amount_cents)) return;
  try {
    const sub = parsed.data.start_now
      ? await startSubscriptionNow(orgId, parsed.data.monthly_amount_cents, new Date(), id)
      : await changeSubscriptionAmount(orgId, parsed.data.monthly_amount_cents, new Date(), id);
    res.json(await actionResponse(orgId, sub));
  } catch (err) {
    if (err instanceof SubscriptionRefused) return refuse(res, err);
    console.error(`[billing-service] plan amount change failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to change the plan amount" });
  }
});

router.post("/v1/accounts/subscriptions/:subscriptionId/cancel", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  const id = planId(req, res);
  if (!id) return;
  try {
    res.json(await actionResponse(orgId, await cancelSubscription(orgId, new Date(), id)));
  } catch (err) {
    if (err instanceof SubscriptionRefused) return refuse(res, err);
    console.error(`[billing-service] plan cancel failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to cancel the plan" });
  }
});

router.post("/v1/accounts/subscriptions/:subscriptionId/resume", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  const id = planId(req, res);
  if (!id) return;
  try {
    res.json(await actionResponse(orgId, await resumeSubscription(orgId, new Date(), id)));
  } catch (err) {
    if (err instanceof SubscriptionRefused) return refuse(res, err);
    console.error(`[billing-service] plan resume failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to resume the plan" });
  }
});

router.post("/v1/accounts/subscriptions/:subscriptionId/pause", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  const id = planId(req, res);
  if (!id) return;
  const parsed = PauseSubscriptionRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "months must be 1, 2 or 3" });
    return;
  }
  try {
    res.json(await actionResponse(orgId, await pauseSubscription(orgId, parsed.data.months, new Date(), id)));
  } catch (err) {
    if (err instanceof SubscriptionRefused) return refuse(res, err);
    console.error(`[billing-service] plan pause failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to pause the plan" });
  }
});

router.post("/v1/accounts/subscriptions/:subscriptionId/unpause", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  const id = planId(req, res);
  if (!id) return;
  try {
    res.json(await actionResponse(orgId, await unpauseSubscription(orgId, new Date(), id)));
  } catch (err) {
    if (err instanceof SubscriptionRefused) return refuse(res, err);
    console.error(`[billing-service] plan unpause failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to unpause the plan" });
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
