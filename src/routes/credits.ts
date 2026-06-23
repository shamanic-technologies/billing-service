import { Router } from "express";
import {
  CreditGrantRequestSchema,
  AdminCreditGrantRequestSchema,
} from "../schemas.js";
import {
  grantCredit,
  grantAdminCredit,
  listGrantsForOrg,
  listAllGrants,
  sumLocalPromoCreditsForOrg,
  UnknownGrantReasonError,
  GrantPromoCodeMissingError,
} from "../lib/promos.js";
import { addCents, subCents } from "../lib/cents.js";
import {
  getCustomerByOrg,
  sumSucceededTopupsForCustomer,
} from "../lib/stripe-service-client.js";
import { fetchRunsOrgUsageTotal } from "../lib/runs-client.js";
import { computeBalance } from "../lib/balance.js";

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// System sentinel userId mirroring routes/internal.ts. Internal grants are
// service-to-service; downstream stripe-service / runs-service calls need an
// identity header pair but there is no human user behind the action.
const INTERNAL_USER_ID = "00000000-0000-0000-0000-000000000000";

// POST /internal/credits/grant — platform-issued credit grant.
//
// Auth: x-api-key only (orgId is in the body; no x-org-id header required).
// Body: { orgId, amountCents, reason: 'invite_reward' | 'invite_welcome' }
// Resp: { ok: true, newBalanceCents }
//
// Fails loud on:
//   - invalid body / unknown reason → 400
//   - stripe-service or runs-service unreachable while composing balance → 502
//     (grant write itself is already committed and idempotent — caller may retry)
router.post("/internal/credits/grant", async (req, res) => {
  const parsed = CreditGrantRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const { orgId, amountCents, reason } = parsed.data;

  try {
    await grantCredit(orgId, amountCents, reason);
  } catch (err) {
    if (err instanceof UnknownGrantReasonError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof GrantPromoCodeMissingError) {
      console.error("[billing-service] credits/grant seed missing:", err);
      res.status(500).json({ error: err.message });
      return;
    }
    throw err;
  }

  const identity: Record<string, string> = {
    "x-org-id": orgId,
    "x-user-id": INTERNAL_USER_ID,
  };

  let newBalanceCents: string;
  try {
    const customer = await getCustomerByOrg(identity);
    const [paidTopups, localCredits, runsUsage] = await Promise.all([
      sumSucceededTopupsForCustomer(identity, customer.id),
      sumLocalPromoCreditsForOrg(orgId),
      fetchRunsOrgUsageTotal(orgId, identity),
    ]);
    const credited = addCents(paidTopups, localCredits);
    newBalanceCents = subCents(credited, runsUsage.spent_cents);
  } catch (err) {
    console.error("[billing-service] credits/grant compose balance failed:", err);
    res
      .status(502)
      .json({ error: "Grant applied but failed to compose new balance" });
    return;
  }

  console.log(
    `[billing-service] credit grant: org=${orgId} amount=${amountCents} reason=${reason} balance=${newBalanceCents}`
  );

  res.json({ ok: true as const, newBalanceCents });
});

// POST /v1/credits/grant — staff grant of an arbitrary credit amount to an org.
//
// Auth: x-api-key (service-to-service, via gateway) + x-org-id (internal org
// UUID). grantedBy = x-email (the staff member). Body: { amountCents, note?,
// idempotencyKey }. Grants STACK on a fresh idempotencyKey; a retry with the
// same key never double-grants. reason is fixed to admin_grant.
//
// Resp: { ok: true, newBalanceCents }.
// Fails loud: 400 invalid body / org; 500 admin_grant seed missing; 502 when
// balance compose fails (grant write is already committed + idempotent).
router.post("/v1/credits/grant", async (req, res) => {
  const orgId = req.headers["x-org-id"] as string | undefined;
  if (!orgId) {
    console.error(`[billing-400] ${req.method} ${req.path}: missing x-org-id`);
    res.status(400).json({ error: "x-org-id header is required" });
    return;
  }
  if (!UUID_RE.test(orgId)) {
    console.error(
      `[billing-400] ${req.method} ${req.path}: invalid x-org-id="${orgId}" (not a UUID)`
    );
    res.status(400).json({ error: "x-org-id must be a valid UUID" });
    return;
  }

  const grantedBy = (req.headers["x-email"] as string | undefined) ?? null;

  const parsed = AdminCreditGrantRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const { amountCents, note, idempotencyKey } = parsed.data;

  try {
    await grantAdminCredit(orgId, amountCents, note ?? null, grantedBy, idempotencyKey);
  } catch (err) {
    if (err instanceof GrantPromoCodeMissingError) {
      console.error("[billing-service] credits/grant admin seed missing:", err);
      res.status(500).json({ error: err.message });
      return;
    }
    throw err;
  }

  let newBalanceCents: string;
  try {
    const snapshot = await computeBalance(orgId);
    newBalanceCents = snapshot.balanceCents;
  } catch (err) {
    console.error("[billing-service] credits/grant compose balance failed:", err);
    res
      .status(502)
      .json({ error: "Grant applied but failed to compose new balance" });
    return;
  }

  console.log(
    `[billing-service] admin credit grant: org=${orgId} amount=${amountCents} by=${grantedBy ?? "(unknown)"} key=${idempotencyKey} balance=${newBalanceCents}`
  );

  res.json({ ok: true as const, newBalanceCents });
});

// GET /v1/credits/grants — list this org's credit grants (oversight ledger).
// Auth: x-api-key + x-org-id. Resp: { grants: [...] } newest first.
router.get("/v1/credits/grants", async (req, res) => {
  const orgId = req.headers["x-org-id"] as string | undefined;
  if (!orgId) {
    console.error(`[billing-400] ${req.method} ${req.path}: missing x-org-id`);
    res.status(400).json({ error: "x-org-id header is required" });
    return;
  }
  if (!UUID_RE.test(orgId)) {
    console.error(
      `[billing-400] ${req.method} ${req.path}: invalid x-org-id="${orgId}" (not a UUID)`
    );
    res.status(400).json({ error: "x-org-id must be a valid UUID" });
    return;
  }

  const grants = await listGrantsForOrg(orgId);
  res.json({ grants });
});

// GET /internal/credits/grants — list ALL orgs' credit grants (platform-wide
// oversight ledger). Auth: x-api-key only (no org scope).
router.get("/internal/credits/grants", async (_req, res) => {
  const grants = await listAllGrants();
  res.json({ grants });
});

export default router;
