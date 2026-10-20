import { Router, type Request, type Response } from "express";
import { requireOrgHeaders } from "../middleware/auth.js";
import {
  clearMonthlyChargeLimit,
  readMonthlyChargeLimitState,
  setMonthlyChargeLimit,
} from "../lib/monthly-charge-limit.js";
import { notifyOwnerBillingEvent, usd } from "../lib/owner-alerts.js";
import { SetMonthlyChargeLimitRequestSchema } from "../schemas.js";

/**
 * MONTHLY CHARGE LIMIT — see lib/monthly-charge-limit. Two surfaces, one function:
 *   - /v1/accounts/monthly_charge_limit                 the customer via the gateway
 *   - /internal/accounts/by-org/:orgId/monthly-charge-limit   staff / services
 * No billing account is needed (or created): onboarding may state it first.
 */
const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function read(orgId: string, res: Response): Promise<void> {
  try {
    res.json(await readMonthlyChargeLimitState(orgId));
  } catch (err) {
    console.error(`[billing-service] monthly charge limit read failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to read this month's spend or card charges" });
  }
}

async function set(orgId: string, userId: string | null, req: Request, res: Response): Promise<void> {
  const parsed = SetMonthlyChargeLimitRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const cents = parsed.data.monthly_charge_limit_cents;
  await setMonthlyChargeLimit(orgId, cents, userId);
  notifyOwnerBillingEvent({ orgId, emoji: "🧱", text: `Monthly charge limit set to ${usd(cents)}` });
  await read(orgId, res);
}

async function clear(orgId: string, res: Response): Promise<void> {
  const removed = await clearMonthlyChargeLimit(orgId);
  if (removed) notifyOwnerBillingEvent({ orgId, emoji: "🧱", text: "Monthly charge limit removed" });
  await read(orgId, res);
}

function guard(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error("[billing-service] monthly charge limit route failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  };
}

function orgParam(req: Request, res: Response): string | null {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a valid UUID" });
    return null;
  }
  return orgId;
}

router.get(
  "/v1/accounts/monthly_charge_limit",
  requireOrgHeaders,
  guard((req, res) => read(req.headers["x-org-id"] as string, res))
);
router.put(
  "/v1/accounts/monthly_charge_limit",
  requireOrgHeaders,
  guard((req, res) => set(req.headers["x-org-id"] as string, (req.headers["x-user-id"] as string) ?? null, req, res))
);
router.delete(
  "/v1/accounts/monthly_charge_limit",
  requireOrgHeaders,
  guard((req, res) => clear(req.headers["x-org-id"] as string, res))
);

router.get(
  "/internal/accounts/by-org/:orgId/monthly-charge-limit",
  guard(async (req, res) => {
    const orgId = orgParam(req, res);
    if (orgId) await read(orgId, res);
  })
);
router.put(
  "/internal/accounts/by-org/:orgId/monthly-charge-limit",
  guard(async (req, res) => {
    const orgId = orgParam(req, res);
    if (orgId) await set(orgId, null, req, res);
  })
);
router.delete(
  "/internal/accounts/by-org/:orgId/monthly-charge-limit",
  guard(async (req, res) => {
    const orgId = orgParam(req, res);
    if (orgId) await clear(orgId, res);
  })
);

export default router;
