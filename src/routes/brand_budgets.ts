import { Router } from "express";
import { requireOrgHeaders } from "../middleware/auth.js";
import { SetBrandDailyBudgetRequestSchema } from "../schemas.js";
import { parseNonNegativeCents } from "../lib/cents.js";
import {
  getBrandDailyBudget,
  upsertBrandDailyBudget,
} from "../lib/brand-budgets.js";

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /internal/brands/:brandId/daily-budget — read a brand's current daily
// budget (the per-day spend ceiling for that brand's active work).
//
// Auth: x-api-key (service-to-service). NO user context — campaign-service calls
// this per loop on a scheduler, keyed by brandId only.
// Resp: { brandId, dailyBudgetCents, updatedAt }. Unset brand → dailyBudgetCents
// and updatedAt are null (a brand with no configured budget is a legitimate
// state; the consumer decides what to do with it). 400 on a non-UUID brandId.
router.get("/internal/brands/:brandId/daily-budget", async (req, res) => {
  const { brandId } = req.params;
  if (!UUID_RE.test(brandId)) {
    res.status(400).json({ error: "brandId must be a valid UUID" });
    return;
  }

  const stored = await getBrandDailyBudget(brandId);
  res.json({
    brandId,
    dailyBudgetCents: stored ? stored.dailyBudgetCents : null,
    updatedAt: stored ? stored.updatedAt.toISOString() : null,
  });
});

// PATCH /v1/brands/:brandId/daily-budget — set / update a brand's daily budget.
//
// Auth: x-api-key + org headers (the user, via the gateway). org_id is captured
// from x-org-id for provenance; the value is keyed by brandId.
// Body: { dailyBudgetCents } — non-negative (0 = explicit pause; null/unset is a
// separate state expressed by never setting a row). Fractional cents allowed.
// Resp: { brandId, orgId, dailyBudgetCents, updatedAt } | 400 invalid.
router.patch(
  "/v1/brands/:brandId/daily-budget",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }

    const parsed = SetBrandDailyBudgetRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    let dailyBudgetCents: string;
    try {
      dailyBudgetCents = parseNonNegativeCents(parsed.data.dailyBudgetCents);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "invalid dailyBudgetCents",
      });
      return;
    }

    const orgId = req.headers["x-org-id"] as string;
    const row = await upsertBrandDailyBudget(brandId, orgId, dailyBudgetCents);
    console.log(
      `[billing-service] brand daily budget set: brand=${brandId} org=${orgId} budget=${dailyBudgetCents}`
    );
    res.json({
      brandId: row.brandId,
      orgId: row.orgId,
      dailyBudgetCents: row.dailyBudgetCents,
      updatedAt: row.updatedAt.toISOString(),
    });
  }
);

export default router;
