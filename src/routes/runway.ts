import { Router } from "express";
import { requireOrgHeaders } from "../middleware/auth.js";
import { getRunway } from "../lib/runway.js";
import { invalidateSpendableSnapshot } from "../lib/spendable-budget-snapshots.js";
import { isRealOrgId } from "../lib/org-id.js";

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

// POST /internal/spendable-budget-snapshots/invalidate — campaign-service's push
// (MON-PAGE-SPEED-2-1112): a campaign of this (org, brand) changed on its side, so
// the stored spendable-budget answer the runway serves is stale. Stamped here and
// never served again; the next runway read asks campaign-service once and stores
// the new answer. API key only, the pair is in the body (a sweep crosses orgs).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.post("/internal/spendable-budget-snapshots/invalidate", async (req, res) => {
  const pairs = Array.isArray(req.body?.brands) ? (req.body.brands as unknown[]) : null;
  if (
    !pairs ||
    pairs.length === 0 ||
    pairs.length > 500 ||
    !pairs.every(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as { orgId?: unknown }).orgId === "string" &&
        typeof (p as { brandId?: unknown }).brandId === "string" &&
        isRealOrgId((p as { orgId: string }).orgId) &&
        UUID_RE.test((p as { brandId: string }).brandId)
    )
  ) {
    res.status(400).json({ error: "brands must be 1-500 { orgId, brandId } pairs of real UUIDs" });
    return;
  }
  try {
    let invalidated = 0;
    for (const p of pairs as Array<{ orgId: string; brandId: string }>) {
      invalidated += await invalidateSpendableSnapshot(p.orgId, p.brandId);
    }
    res.json({ invalidated });
  } catch (err) {
    console.error("[billing-service] spendable snapshot invalidation failed:", err);
    res.status(500).json({ error: "Invalidation failed" });
  }
});

export default router;
