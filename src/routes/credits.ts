import { Router } from "express";
import { CreditGrantRequestSchema } from "../schemas.js";
import {
  grantCredit,
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

const router = Router();

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

export default router;
