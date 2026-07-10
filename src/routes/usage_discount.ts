import { Router } from "express";
import { SetUsageDiscountRequestSchema } from "../schemas.js";
import {
  getUsageDiscount,
  setUsageDiscount,
  removeUsageDiscount,
  InvalidUsageDiscountError,
} from "../lib/usage-discount.js";

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Staff-managed per-org platform-usage discount. Auth mirrors the credit-grant
// path (POST /v1/credits/grant): x-api-key (service via gateway, enforced app-
// wide by requireApiKey) + x-org-id (target org UUID); the gateway gates these to
// staff. x-email is the staff member (recorded as setBy on a set). ONE value per
// org — replaceable (PUT) and removable (DELETE → null).
function resolveOrgId(
  req: import("express").Request,
  res: import("express").Response
): string | null {
  const orgId = req.headers["x-org-id"] as string | undefined;
  if (!orgId) {
    console.error(`[billing-400] ${req.method} ${req.path}: missing x-org-id`);
    res.status(400).json({ error: "x-org-id header is required" });
    return null;
  }
  if (!UUID_RE.test(orgId)) {
    console.error(
      `[billing-400] ${req.method} ${req.path}: invalid x-org-id="${orgId}" (not a UUID)`
    );
    res.status(400).json({ error: "x-org-id must be a valid UUID" });
    return null;
  }
  return orgId;
}

// GET /v1/usage-discount — read this org's usage discount.
// → { orgId, discountPct, setBy, setAt } (discountPct/setBy/setAt null when unset).
router.get("/v1/usage-discount", async (req, res) => {
  const orgId = resolveOrgId(req, res);
  if (!orgId) return;

  const discount = await getUsageDiscount(orgId);
  res.json({
    orgId,
    discountPct: discount ? discount.discountPct : null,
    setBy: discount ? discount.setBy : null,
    setAt: discount ? discount.setAt : null,
  });
});

// PUT /v1/usage-discount — set / replace this org's usage discount.
// Body: { discountPct: integer 0–100 }. setBy = x-email.
// Fail loud: out-of-range / missing discountPct → 400 (no clamp, no default).
router.put("/v1/usage-discount", async (req, res) => {
  const orgId = resolveOrgId(req, res);
  if (!orgId) return;

  const parsed = SetUsageDiscountRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const setBy = (req.headers["x-email"] as string | undefined) ?? null;

  let discount;
  try {
    discount = await setUsageDiscount(orgId, parsed.data.discountPct, setBy);
  } catch (err) {
    if (err instanceof InvalidUsageDiscountError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }

  console.log(
    `[billing-service] usage discount set: org=${orgId} pct=${discount.discountPct} by=${setBy ?? "(unknown)"}`
  );

  res.json({
    orgId,
    discountPct: discount.discountPct,
    setBy: discount.setBy,
    setAt: discount.setAt,
  });
});

// DELETE /v1/usage-discount — remove this org's usage discount (→ null).
// Idempotent: no discount → still 200 with discountPct null. Not retroactive.
router.delete("/v1/usage-discount", async (req, res) => {
  const orgId = resolveOrgId(req, res);
  if (!orgId) return;

  const removed = await removeUsageDiscount(orgId);
  console.log(
    `[billing-service] usage discount ${removed ? "removed" : "remove (no-op, none set)"}: org=${orgId}`
  );

  res.json({ orgId, discountPct: null, setBy: null, setAt: null });
});

export default router;
