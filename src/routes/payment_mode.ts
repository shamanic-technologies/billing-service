import { Router, type Request, type Response } from "express";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { findOrCreateAccount } from "../lib/account.js";
import {
  getPaymentMode,
  setPaymentMode,
  PaymentModeAccountNotFound,
  PaymentModeSwitchRefused,
} from "../lib/payment-mode.js";
import { SetPaymentModeRequestSchema } from "../schemas.js";

/**
 * PREPAID or POSTPAID — see lib/payment-mode for what each means and what a
 * switch does. Two surfaces, one function:
 *   - /v1/accounts/payment_mode       the customer via the gateway (org headers)
 *   - /internal/accounts/by-org/:orgId/payment-mode   staff / services, orgId in
 *     the path, x-api-key only (the gateway gates it to staff)
 */
const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function applySwitch(orgId: string, req: Request, res: Response): Promise<void> {
  const parsed = SetPaymentModeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const state = await setPaymentMode(orgId, parsed.data.payment_mode);
    res.json({
      org_id: state.orgId,
      payment_mode: state.paymentMode,
      settled_cents: state.settledCents,
      auto_topup_enabled: state.autoTopupEnabled,
    });
  } catch (err) {
    if (err instanceof PaymentModeSwitchRefused) {
      res.status(409).json({ error: err.message, code: err.code, owed_cents: err.owedCents });
      return;
    }
    if (err instanceof PaymentModeAccountNotFound) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }
    console.error(`[billing-service] payment mode switch failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to switch payment mode" });
  }
}

router.get("/v1/accounts/payment_mode", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const account = await findOrCreateAccount(orgId, userId, forwardWorkflowHeaders(getWorkflowHeaders(req)));
    res.json({ org_id: orgId, payment_mode: account.paymentMode });
  } catch (err) {
    console.error("[billing-service] Error reading payment mode:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/v1/accounts/payment_mode", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    // Onboarding may choose before any other billing touch, so the account is
    // created here exactly as every other /v1 read creates it.
    await findOrCreateAccount(orgId, userId, forwardWorkflowHeaders(getWorkflowHeaders(req)));
    await applySwitch(orgId, req, res);
  } catch (err) {
    console.error("[billing-service] Error switching payment mode:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/internal/accounts/by-org/:orgId/payment-mode", async (req, res) => {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a valid UUID" });
    return;
  }
  try {
    const mode = await getPaymentMode(orgId);
    if (mode === null) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }
    res.json({ org_id: orgId, payment_mode: mode });
  } catch (err) {
    console.error("[billing-service] Error reading payment mode:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/internal/accounts/by-org/:orgId/payment-mode", async (req, res) => {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a valid UUID" });
    return;
  }
  await applySwitch(orgId, req, res);
});

export default router;
