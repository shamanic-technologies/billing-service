import { Router, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import {
  asFreeCreditOffer,
  offerDefaultTopupMinimums,
  topupMinimumsFor,
} from "../lib/free-credit-offer.js";
import { SetTopupMinimumsRequestSchema } from "../schemas.js";

/**
 * PER-ACCOUNT TOP-UP MINIMUMS (owner 2026-10-13: « tu me soules avec tes limites
 * hardcodées »). The smallest top-up (checkout, on-demand charge, auto-reload amount)
 * and the smallest auto-reload threshold an org may set. Default = the org's offer
 * (match_100: $100 / $5, every other offer: none); STAFF can replace either for one
 * org. null on the PUT = back to the offer default; an absent key = unchanged.
 *
 * Two surfaces, one function:
 *   - /v1/accounts/topup_minimums                       staff via the api-service gateway
 *     (x-api-key + x-org-id; the PUT requires x-email = the staff member)
 *   - /internal/accounts/by-org/:orgId/topup-minimums   services, orgId in the path
 * The org must already have a billing account (its first billing touch creates it):
 * creating one here would skip the fresh-account decisions findOrCreateAccount makes.
 */
const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function read(orgId: string, res: Response): Promise<void> {
  const [account] = await db
    .select({
      freeCreditOffer: billingAccounts.freeCreditOffer,
      topupMinimumCents: billingAccounts.topupMinimumCents,
      reloadThresholdMinimumCents: billingAccounts.reloadThresholdMinimumCents,
      topupMinimumsSetBy: billingAccounts.topupMinimumsSetBy,
      topupMinimumsSetAt: billingAccounts.topupMinimumsSetAt,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  if (!account) {
    res.status(404).json({ error: "Billing account not found", code: "account_not_found" });
    return;
  }
  const offer = asFreeCreditOffer(account.freeCreditOffer);
  const effective = topupMinimumsFor(account);
  const defaults = offerDefaultTopupMinimums(offer);
  res.json({
    org_id: orgId,
    free_credit_offer: offer,
    topup_minimum_cents: effective.topupMinimumCents,
    reload_threshold_minimum_cents: effective.reloadThresholdMinimumCents,
    topup_minimum_source: account.topupMinimumCents != null ? "account" : "offer_default",
    reload_threshold_minimum_source:
      account.reloadThresholdMinimumCents != null ? "account" : "offer_default",
    offer_default_topup_minimum_cents: defaults.topupMinimumCents,
    offer_default_reload_threshold_minimum_cents: defaults.reloadThresholdMinimumCents,
    set_by: account.topupMinimumsSetBy,
    set_at: account.topupMinimumsSetAt ? account.topupMinimumsSetAt.toISOString() : null,
  });
}

async function set(orgId: string, setBy: string | null, req: Request, res: Response): Promise<void> {
  const parsed = SetTopupMinimumsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const body = parsed.data;
  const patch: Partial<typeof billingAccounts.$inferInsert> = {
    topupMinimumsSetBy: setBy,
    topupMinimumsSetAt: sql`now()` as unknown as Date,
    updatedAt: sql`now()` as unknown as Date,
  };
  if (body.topup_minimum_cents !== undefined) patch.topupMinimumCents = body.topup_minimum_cents;
  if (body.reload_threshold_minimum_cents !== undefined) {
    patch.reloadThresholdMinimumCents = body.reload_threshold_minimum_cents;
  }
  const updated = await db
    .update(billingAccounts)
    .set(patch)
    .where(eq(billingAccounts.orgId, orgId))
    .returning({ id: billingAccounts.id });
  if (updated.length === 0) {
    res.status(404).json({ error: "Billing account not found", code: "account_not_found" });
    return;
  }
  console.log(
    `[billing-service] topup minimums set: org=${orgId} topup=${body.topup_minimum_cents} threshold=${body.reload_threshold_minimum_cents} by=${setBy ?? "(service)"}`
  );
  await read(orgId, res);
}

function guard(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error("[billing-service] topup minimums route failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  };
}

function headerOrg(req: Request, res: Response): string | null {
  const orgId = req.headers["x-org-id"] as string | undefined;
  if (!orgId || !UUID_RE.test(orgId)) {
    res.status(400).json({ error: "x-org-id header is required and must be a valid UUID" });
    return null;
  }
  return orgId;
}

function pathOrg(req: Request, res: Response): string | null {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a valid UUID" });
    return null;
  }
  return orgId;
}

router.get(
  "/v1/accounts/topup_minimums",
  guard(async (req, res) => {
    const orgId = headerOrg(req, res);
    if (orgId) await read(orgId, res);
  })
);
router.put(
  "/v1/accounts/topup_minimums",
  guard(async (req, res) => {
    const orgId = headerOrg(req, res);
    if (!orgId) return;
    const setBy = (req.headers["x-email"] as string | undefined)?.trim();
    if (!setBy) {
      res.status(400).json({ error: "x-email header (the staff member) is required" });
      return;
    }
    await set(orgId, setBy, req, res);
  })
);

router.get(
  "/internal/accounts/by-org/:orgId/topup-minimums",
  guard(async (req, res) => {
    const orgId = pathOrg(req, res);
    if (orgId) await read(orgId, res);
  })
);
router.put(
  "/internal/accounts/by-org/:orgId/topup-minimums",
  guard(async (req, res) => {
    const orgId = pathOrg(req, res);
    if (!orgId) return;
    const setBy = (req.headers["x-email"] as string | undefined)?.trim() || null;
    await set(orgId, setBy, req, res);
  })
);

export default router;
