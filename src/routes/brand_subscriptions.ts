/**
 * Per-brand daily subscription wiring.
 *
 * billing is the conductor: it tells stripe-service to create / change-amount /
 * pause / resume the brand's recurring daily subscription, and keeps the brand
 * daily-budget (brand_daily_budgets) in lock-step — one logical operation per
 * lifecycle event. It also receives the card-confirmed signal from stripe-service
 * (Stripe webhook → stripe-service → here) and grants the one-time $25 welcome
 * gift, deduped across 4 keys.
 *
 * Three dials kept in sync per brand:
 *   1. Stripe subscription amount  (owned by stripe-service; billing calls it)
 *   2. brand daily-budget ceiling  (billing-owned; 0 = pause)
 *   3. pause/resume collection state
 *
 * The $25 grant fires on card-confirmed (async), NOT at onboarding — a brand can
 * be onboarded before the card is confirmed.
 *
 * Fail-loud throughout: a stripe-service error propagates (502 via the async
 * error handler); a balance-compose error after a committed grant returns 502.
 */

import { Router } from "express";
import { requireOrgHeaders } from "../middleware/auth.js";
import {
  SubscriptionAmountRequestSchema,
  CardConfirmedRequestSchema,
} from "../schemas.js";
import { upsertBrandDailyBudget } from "../lib/brand-budgets.js";
import {
  createBrandSubscription,
  updateBrandSubscriptionAmount,
  pauseBrandSubscription,
  resumeBrandSubscription,
} from "../lib/subscription-service-client.js";
import {
  grantBrandWelcomeIfEligible,
  BrandWelcomeCodeMissingError,
} from "../lib/brand-welcome.js";
import { computeBalance } from "../lib/balance.js";

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /v1/brands/:brandId/subscription — onboard a brand at a chosen daily
// amount. Creates the recurring daily subscription (stripe-service) AND sets the
// brand daily-budget = the chosen amount. The $25 gift is NOT granted here — it
// fires on the card-confirmed signal.
router.post(
  "/v1/brands/:brandId/subscription",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    const parsed = SubscriptionAmountRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    const { dailyAmountCents } = parsed.data;
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;

    try {
      const sub = await createBrandSubscription(brandId, {
        orgId,
        userId,
        dailyAmountCents,
      });
      const budget = await upsertBrandDailyBudget(
        brandId,
        orgId,
        String(dailyAmountCents)
      );
      console.log(
        `[billing-service] brand subscription onboarded: brand=${brandId} org=${orgId} amount=${dailyAmountCents} sub=${sub.subscriptionId}`
      );
      res.json({
        brandId,
        orgId,
        subscriptionId: sub.subscriptionId,
        status: sub.status,
        dailyAmountCents,
        dailyBudgetCents: budget.dailyBudgetCents,
      });
    } catch (err) {
      console.error("[billing-service] brand subscription onboard failed:", err);
      res.status(502).json({ error: "Failed to create brand subscription" });
    }
  }
);

// PATCH /v1/brands/:brandId/subscription — change the daily amount. Updates the
// Stripe subscription amount AND the brand daily-budget together.
router.patch(
  "/v1/brands/:brandId/subscription",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    const parsed = SubscriptionAmountRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    const { dailyAmountCents } = parsed.data;
    const orgId = req.headers["x-org-id"] as string;

    try {
      const sub = await updateBrandSubscriptionAmount(brandId, dailyAmountCents);
      const budget = await upsertBrandDailyBudget(
        brandId,
        orgId,
        String(dailyAmountCents)
      );
      console.log(
        `[billing-service] brand subscription amount changed: brand=${brandId} org=${orgId} amount=${dailyAmountCents}`
      );
      res.json({
        brandId,
        orgId,
        subscriptionId: sub.subscriptionId,
        status: sub.status,
        dailyAmountCents,
        dailyBudgetCents: budget.dailyBudgetCents,
      });
    } catch (err) {
      console.error("[billing-service] brand subscription amount change failed:", err);
      res.status(502).json({ error: "Failed to update brand subscription" });
    }
  }
);

// POST /v1/brands/:brandId/subscription/pause — brand went dry. Pauses Stripe
// collection AND sets the brand daily-budget to 0 (the existing pause sentinel).
router.post(
  "/v1/brands/:brandId/subscription/pause",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    const orgId = req.headers["x-org-id"] as string;

    try {
      const sub = await pauseBrandSubscription(brandId);
      const budget = await upsertBrandDailyBudget(brandId, orgId, "0");
      console.log(
        `[billing-service] brand subscription paused: brand=${brandId} org=${orgId}`
      );
      res.json({
        brandId,
        orgId,
        status: sub.status,
        dailyBudgetCents: budget.dailyBudgetCents,
      });
    } catch (err) {
      console.error("[billing-service] brand subscription pause failed:", err);
      res.status(502).json({ error: "Failed to pause brand subscription" });
    }
  }
);

// POST /v1/brands/:brandId/subscription/resume — reverse the pause. Resumes Stripe
// collection AND restores the brand daily-budget to the subscription's amount
// (read back from stripe-service — billing stores no amount of its own).
router.post(
  "/v1/brands/:brandId/subscription/resume",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    const orgId = req.headers["x-org-id"] as string;

    try {
      const sub = await resumeBrandSubscription(brandId);
      if (typeof sub.dailyAmountCents !== "number") {
        throw new Error(
          `stripe-service resume returned no dailyAmountCents for brand ${brandId}`
        );
      }
      const budget = await upsertBrandDailyBudget(
        brandId,
        orgId,
        String(sub.dailyAmountCents)
      );
      console.log(
        `[billing-service] brand subscription resumed: brand=${brandId} org=${orgId} amount=${sub.dailyAmountCents}`
      );
      res.json({
        brandId,
        orgId,
        status: sub.status,
        dailyAmountCents: sub.dailyAmountCents,
        dailyBudgetCents: budget.dailyBudgetCents,
      });
    } catch (err) {
      console.error("[billing-service] brand subscription resume failed:", err);
      res.status(502).json({ error: "Failed to resume brand subscription" });
    }
  }
);

// POST /internal/brands/:brandId/subscription/card-confirmed — stripe-service
// calls this (Stripe webhook → stripe-service → here) when the subscription's
// card is added/confirmed. Grants the one-time $25 welcome gift, deduped across
// org_id / user_id / brand_id / card_fingerprint. Service-auth only (no user
// context — the user/org come from the body, resolved from subscription metadata
// by stripe-service).
router.post(
  "/internal/brands/:brandId/subscription/card-confirmed",
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    const parsed = CardConfirmedRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    const { orgId, userId, cardFingerprint } = parsed.data;

    let result;
    try {
      result = await grantBrandWelcomeIfEligible({
        orgId,
        userId,
        brandId,
        cardFingerprint,
      });
    } catch (err) {
      if (err instanceof BrandWelcomeCodeMissingError) {
        console.error("[billing-service] card-confirmed seed missing:", err);
        res.status(500).json({ error: err.message });
        return;
      }
      console.error("[billing-service] card-confirmed grant failed:", err);
      res.status(500).json({ error: "Failed to grant brand welcome" });
      return;
    }

    let newBalanceCents: string;
    try {
      const snapshot = await computeBalance(orgId);
      newBalanceCents = snapshot.balanceCents;
    } catch (err) {
      console.error(
        "[billing-service] card-confirmed compose balance failed:",
        err
      );
      res
        .status(502)
        .json({ error: "Grant applied but failed to compose new balance" });
      return;
    }

    console.log(
      `[billing-service] brand welcome card-confirmed: brand=${brandId} org=${orgId} granted=${result.granted} amount=${result.amountCents}`
    );
    res.json({
      ok: true as const,
      granted: result.granted,
      amountCents: result.amountCents,
      newBalanceCents,
    });
  }
);

export default router;
