import type { Request, Response } from "express";
import { Router } from "express";
import { requireOrgHeaders } from "../middleware/auth.js";
import {
  MissionStatusChangedRequestSchema,
  SetBrandDailyBudgetRequestSchema,
  SetBrandSalesBudgetRequestSchema,
} from "../schemas.js";
import { parseNonNegativeCents } from "../lib/cents.js";
import {
  getBrandDailyBudget,
  getBrandDailyBudgetByDay,
  getBrandDailyBudgetHistory,
  upsertBrandDailyBudget,
  BrandBudgetManagedBySalesBudgetError,
} from "../lib/brand-budgets.js";
import {
  clearBrandSalesBudget,
  getBrandSalesBudget,
  getBrandSalesBudgetHistory,
  setBrandSalesBudget,
  viewOf,
} from "../lib/brand-sales-budget.js";
import {
  MAX_DAY_RANGE_DAYS,
  currentUtcDay,
  parseUtcDay,
  utcDaySpan,
} from "../lib/utc-day.js";
import {
  notifyBrandDailyBudgetChanged,
  notifyMissionStatusChanged,
  statusMoveOf,
} from "../lib/brand-budget-notification.js";
import { brandGrainChange } from "../lib/brand-running-budget.js";

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve + validate the internal `x-org-id` header on a service-to-service read.
 * Returns null and writes the 400 when it is missing or malformed.
 */
function requireInternalOrgId(req: Request, res: Response): string | null {
  const orgId = req.headers["x-org-id"] as string | undefined;
  if (!orgId) {
    console.error(
      `[billing-service] [billing-400] ${req.method} ${req.path}: missing x-org-id`
    );
    res.status(400).json({ error: "x-org-id header is required" });
    return null;
  }
  if (!UUID_RE.test(orgId)) {
    console.error(
      `[billing-service] [billing-400] ${req.method} ${req.path}: invalid x-org-id="${orgId}" (not a UUID)`
    );
    res.status(400).json({ error: "x-org-id must be a valid UUID" });
    return null;
  }
  return orgId;
}

// GET /internal/brands/:brandId/daily-budget — read this org's current daily
// budget for a brand (the per-day spend ceiling for that org+brand).
//
// Auth: x-api-key (service-to-service) + x-org-id. Service callers must send
// the internal org UUID so shared brands never leak budget state across tenants.
// Resp: { brandId, dailyBudgetCents, updatedAt }. Unset brand → dailyBudgetCents
// and updatedAt are null (a brand with no configured budget is a legitimate
// state; the consumer decides what to do with it). 400 on a non-UUID brandId.
router.get("/internal/brands/:brandId/daily-budget", async (req, res) => {
  const { brandId } = req.params;
  if (!UUID_RE.test(brandId)) {
    res.status(400).json({ error: "brandId must be a valid UUID" });
    return;
  }

  const orgId = req.headers["x-org-id"] as string | undefined;
  if (!orgId) {
    console.error(
      `[billing-service] [billing-400] ${req.method} ${req.path}: missing x-org-id`
    );
    res.status(400).json({ error: "x-org-id header is required" });
    return;
  }
  if (!UUID_RE.test(orgId)) {
    console.error(
      `[billing-service] [billing-400] ${req.method} ${req.path}: invalid x-org-id="${orgId}" (not a UUID)`
    );
    res.status(400).json({ error: "x-org-id must be a valid UUID" });
    return;
  }

  const stored = await getBrandDailyBudget(orgId, brandId);
  res.json({
    brandId,
    dailyBudgetCents: stored ? stored.dailyBudgetCents : null,
    updatedAt: stored ? stored.updatedAt.toISOString() : null,
  });
});

// GET /internal/brands/:brandId/daily-budget/history — read this org's ordered
// daily-budget CHANGE history for a brand (the timeline of raises / lowers /
// zeroings), for the customer-health board.
//
// Auth: same as the current-value read — x-api-key (service-to-service) +
// x-org-id (the internal org UUID). Shared brands keep independent per-org
// history. Resp: { brandId, history: [{ dailyBudgetCents, changedAt }] },
// oldest-first (chronological). Forward-only: entries begin when this feature
// shipped, so a brand with no writes since then returns an empty history array
// (a legitimate state — never fabricated). 400 on a non-UUID brandId.
router.get(
  "/internal/brands/:brandId/daily-budget/history",
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }

    const orgId = req.headers["x-org-id"] as string | undefined;
    if (!orgId) {
      console.error(
        `[billing-service] [billing-400] ${req.method} ${req.path}: missing x-org-id`
      );
      res.status(400).json({ error: "x-org-id header is required" });
      return;
    }
    if (!UUID_RE.test(orgId)) {
      console.error(
        `[billing-service] [billing-400] ${req.method} ${req.path}: invalid x-org-id="${orgId}" (not a UUID)`
      );
      res.status(400).json({ error: "x-org-id must be a valid UUID" });
      return;
    }

    const changes = await getBrandDailyBudgetHistory(orgId, brandId);
    res.json({
      brandId,
      history: changes.map((c) => ({
        dailyBudgetCents: c.dailyBudgetCents,
        changedAt: c.changedAt.toISOString(),
      })),
    });
  }
);

// GET /internal/brands/:brandId/daily-budget/by-day?from=&to=
//
// What daily amount was IN FORCE for this brand on each UTC day of a range —
// the past-day read a run-rate consumer needs, answered by replaying the
// append-only change log rather than by anyone snapshotting billing's state.
//
// Auth: same as the current-value and history reads — x-api-key
// (service-to-service) plus x-org-id (the internal org UUID). Shared brands
// keep independent per-org answers.
//
// GRAIN: the BRAND total. brand_daily_budget_changes carries the brand-level
// figure on EVERY write (per-campaign writes included), so the replay is
// complete at that grain. The campaign ceilings are
// upserted in place with no change log of their own, so a past-day answer
// there would be invented — hence no finer read.
//
// Resp: { brandId, orgId, grain: "brand", recordBeginsAt, days: [{ date,
// state, dailyBudgetCents, inForceSince }] }, oldest day first. A day before
// the first recorded change is state "not_recorded" with a null amount — never
// 0, and never the current value back-dated. A RECORDED "0" is a brand the
// customer deliberately defunded, which is a different fact; the two are
// distinguishable by `state`, not by reading a number as a sentinel.
//
// 400 on a non-UUID brandId, a missing/malformed date, to < from, a range over
// MAX_DAY_RANGE_DAYS, or a day in the FUTURE (no change can exist there, so
// answering would be a claim about what has not happened yet). TODAY is
// allowed and answers with the amount in force right now.
router.get(
  "/internal/brands/:brandId/daily-budget/by-day",
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }

    const orgId = requireInternalOrgId(req, res);
    if (!orgId) return;

    const fromRaw = req.query.from;
    const toRaw = req.query.to;
    if (typeof fromRaw !== "string" || typeof toRaw !== "string") {
      res.status(400).json({
        error: "from and to query params are required (YYYY-MM-DD, UTC)",
      });
      return;
    }

    const fromDay = parseUtcDay(fromRaw);
    const toDay = parseUtcDay(toRaw);
    if (!fromDay || !toDay) {
      res
        .status(400)
        .json({ error: "from and to must be valid UTC dates (YYYY-MM-DD)" });
      return;
    }
    if (toDay.getTime() < fromDay.getTime()) {
      res.status(400).json({ error: "to must not be earlier than from" });
      return;
    }
    if (utcDaySpan(fromDay, toDay) > MAX_DAY_RANGE_DAYS) {
      res.status(400).json({
        error: `range must not exceed ${MAX_DAY_RANGE_DAYS} days`,
      });
      return;
    }
    if (toDay.getTime() > currentUtcDay().getTime()) {
      res
        .status(400)
        .json({ error: "to must not be a future UTC day" });
      return;
    }

    const { recordBeginsAt, days } = await getBrandDailyBudgetByDay(
      orgId,
      brandId,
      fromDay,
      toDay
    );
    res.json({ brandId, orgId, grain: "brand", recordBeginsAt, days });
  }
);

// PATCH /v1/brands/:brandId/daily-budget — set / update a brand's daily budget.
//
// Auth: x-api-key + org headers (the user, via the gateway). The value is keyed
// by (x-org-id, brandId), so shared brands have independent org budgets.
// Body: { dailyBudgetCents } — non-negative (0 = explicit pause; null/unset is a
// separate state expressed by never setting a row). Fractional cents allowed.
// Resp: { brandId, orgId, dailyBudgetCents, updatedAt } | 400 invalid.
//
// Every REAL change (a different value, or a first-ever set) also notifies staff
// via the transactional-email-service `brand_daily_budget_changed` event. The
// pre-write value comes from the same transaction as the write, so the reported
// "from" side cannot be stale. The send is strictly fire-and-forget: it can never
// change this response or throw. See lib/brand-budget-notification.ts.
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
    let row;
    let previousDailyBudgetCents: string | null;
    try {
      ({ row, previousDailyBudgetCents } = await upsertBrandDailyBudget(
        orgId,
        brandId,
        dailyBudgetCents
      ));
    } catch (err) {
      if (err instanceof BrandBudgetManagedBySalesBudgetError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    console.log(
      `[billing-service] brand daily budget set: brand=${brandId} org=${orgId} budget=${dailyBudgetCents}`
    );

    void notifyBrandDailyBudgetChanged({
      orgId,
      userId: req.headers["x-user-id"] as string,
      runId: req.headers["x-run-id"] as string,
      brandId,
      previousDailyBudgetCents,
      newDailyBudgetCents: row.dailyBudgetCents,
      changes: brandGrainChange(
        previousDailyBudgetCents,
        row.dailyBudgetCents
      ),
      ceilings: [
        {
          featureSlug: null,
          offerId: null,
          legKey: null,
          dailyBudgetCents: row.dailyBudgetCents,
        },
      ],
      actingEmail: (req.headers["x-email"] as string | undefined) ?? null,
    });

    res.json({
      brandId: row.brandId,
      orgId: row.orgId,
      dailyBudgetCents: row.dailyBudgetCents,
      updatedAt: row.updatedAt.toISOString(),
    });
  }
);

// POST /internal/brands/:brandId/mission-status-changed — campaign-service tells
// billing that a PERSON paused or restarted a mission, after its own write
// committed. The staff email is the budget-change email (one composition): see
// lib/brand-budget-notification.ts. Answers 202 before the email goes out; the
// caller fires this and forgets it.
router.post(
  "/internal/brands/:brandId/mission-status-changed",
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    const orgId = requireInternalOrgId(req, res);
    if (!orgId) return;
    const parsed = MissionStatusChangedRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    const body = parsed.data;
    const move = statusMoveOf(body.fromStatus, body.toStatus);
    if (move) {
      console.log(
        `[billing-service] mission ${move}: brand=${brandId} org=${orgId} campaign=${body.campaignId}`
      );
      const notification = {
        orgId,
        userId: (req.headers["x-user-id"] as string | undefined) ?? "",
        runId: (req.headers["x-run-id"] as string | undefined) ?? "",
        brandId,
        ...body,
        actingEmail: (req.headers["x-email"] as string | undefined) ?? null,
      };
      // Never throws; fire-and-forget.
      void notifyMissionStatusChanged(notification);
    }
    res.status(202).json({ notified: move !== null, move });
  }
);

// --- The brand's ONE daily sales budget (global mode) --------------------
//
// A brand either states ONE daily budget for sales ("global" mode) or does not
// ("campaigns" mode, the default). See lib/brand-sales-budget.ts.
// Every answer carries the mode, so a reader never infers it from a null.

async function composeSalesBudgetView(orgId: string, brandId: string) {
  const view = viewOf(await getBrandSalesBudget(orgId, brandId));
  return {
    mode: view.mode,
    dailyBudgetCents: view.dailyBudgetCents,
    updatedAt: view.updatedAt ? view.updatedAt.toISOString() : null,
  };
}

async function composeSalesBudgetHistory(orgId: string, brandId: string) {
  const changes = await getBrandSalesBudgetHistory(orgId, brandId);
  return changes.map((c) => ({
    mode: c.dailyBudgetCents === null ? "campaigns" : "global",
    dailyBudgetCents: c.dailyBudgetCents,
    changedAt: c.changedAt.toISOString(),
  }));
}

// GET /internal/brands/:brandId/sales-budget — campaign-service reads the mode
// and, in global mode, the amount it allocates. Auth: x-api-key + x-org-id.
router.get("/internal/brands/:brandId/sales-budget", async (req, res) => {
  const { brandId } = req.params;
  if (!UUID_RE.test(brandId)) {
    res.status(400).json({ error: "brandId must be a valid UUID" });
    return;
  }
  const orgId = requireInternalOrgId(req, res);
  if (!orgId) return;
  res.json({ brandId, orgId, ...(await composeSalesBudgetView(orgId, brandId)) });
});

// GET /internal/brands/:brandId/sales-budget/history — every state and clear,
// oldest first. Auth: x-api-key + x-org-id.
router.get(
  "/internal/brands/:brandId/sales-budget/history",
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    const orgId = requireInternalOrgId(req, res);
    if (!orgId) return;
    res.json({
      brandId,
      orgId,
      history: await composeSalesBudgetHistory(orgId, brandId),
    });
  }
);

// GET /v1/brands/:brandId/sales-budget — the same answer for the user (gateway).
router.get(
  "/v1/brands/:brandId/sales-budget",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    const orgId = req.headers["x-org-id"] as string;
    res.json({ brandId, orgId, ...(await composeSalesBudgetView(orgId, brandId)) });
  }
);

// GET /v1/brands/:brandId/sales-budget/history — the history for the user.
router.get(
  "/v1/brands/:brandId/sales-budget/history",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    const orgId = req.headers["x-org-id"] as string;
    res.json({
      brandId,
      orgId,
      history: await composeSalesBudgetHistory(orgId, brandId),
    });
  }
);

// PUT /v1/brands/:brandId/sales-budget — state the brand's one daily sales
// budget (the brand enters global mode). Body: { dailyBudgetCents } non-negative
// (0 is legal). The campaign ceilings are untouched. Auth: org headers.
router.put(
  "/v1/brands/:brandId/sales-budget",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    const parsed = SetBrandSalesBudgetRequestSchema.safeParse(req.body);
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
    const { row, previousDailyBudgetCents } = await setBrandSalesBudget(
      orgId,
      brandId,
      dailyBudgetCents
    );
    console.log(
      `[billing-service] brand sales budget set: brand=${brandId} org=${orgId} budget=${row.dailyBudgetCents} previous=${previousDailyBudgetCents ?? "campaigns-mode"}`
    );
    res.json({
      brandId,
      orgId,
      mode: "global",
      dailyBudgetCents: row.dailyBudgetCents,
      updatedAt: row.updatedAt.toISOString(),
      previousDailyBudgetCents,
    });
  }
);

// DELETE /v1/brands/:brandId/sales-budget — clear it: the brand is back on its
// campaign ceilings. Idempotent (a brand already in campaigns mode answers
// cleared: false). Auth: org headers.
router.delete(
  "/v1/brands/:brandId/sales-budget",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    const orgId = req.headers["x-org-id"] as string;
    const result = await clearBrandSalesBudget(orgId, brandId);
    if (result.cleared) {
      console.log(
        `[billing-service] brand sales budget cleared: brand=${brandId} org=${orgId} previous=${result.previousDailyBudgetCents} campaigns=${result.campaignsDailyBudgetCents ?? "none"}`
      );
    }
    res.json({
      brandId,
      orgId,
      mode: "campaigns",
      dailyBudgetCents: null,
      updatedAt: null,
      cleared: result.cleared,
      previousDailyBudgetCents: result.previousDailyBudgetCents,
      campaignsDailyBudgetCents: result.campaignsDailyBudgetCents,
    });
  }
);

export default router;
