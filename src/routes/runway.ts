import { Router } from "express";
import { requireOrgHeaders } from "../middleware/auth.js";
import { getRunway } from "../lib/runway.js";

/**
 * GET /v1/accounts/runway — how many days a PREPAID org's spendable balance lasts
 * at its running daily budgets (lib/runway). For the dashboard sidebar balance
 * card; the browser never divides money. Pure read, org headers via the gateway.
 */
const router = Router();

router.get("/v1/accounts/runway", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  try {
    const runway = await getRunway(orgId);
    if (!runway) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }
    res.json({
      org_id: runway.orgId,
      payment_mode: runway.paymentMode,
      state: runway.state,
      balance_cents: runway.balanceCents,
      daily_budget_cents: runway.dailyBudgetCents,
      configured_daily_budget_cents: runway.configuredDailyBudgetCents,
      days_left: runway.daysLeft,
      days_left_exact: runway.daysLeftExact,
      runs_out_at: runway.runsOutAt,
    });
  } catch (err) {
    console.error(`[billing-service] runway read failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to compute runway" });
  }
});

export default router;
