import { Router } from "express";
import {
  requireOrgHeaders,
  getWorkflowHeaders,
  forwardWorkflowHeaders,
} from "../middleware/auth.js";
import { RedeemPromotionCodeRequestSchema } from "../schemas.js";
import { findOrCreateAccount } from "../lib/account.js";
import { traceEvent } from "../lib/trace-event.js";
import {
  redeemPromoCode,
  sumLocalPromoCreditsForOrg,
  PromoNotFoundError,
  PromoExpiredError,
  PromoExhaustedError,
  PromoAlreadyRedeemedError,
} from "../lib/promos.js";

const router = Router();

// POST /v1/promotion_codes/redeem — redeem a promo code for bonus credits.
// Pure billing-local op: no Stripe call. The credit lives in `local_promos` and
// composes into `available_cents` via sum at read time.
router.post("/v1/promotion_codes/redeem", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  const userId = req.headers["x-user-id"] as string;
  const runId = req.headers["x-run-id"] as string;
  const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));

  const parsed = RedeemPromotionCodeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { code } = parsed.data;

  traceEvent(runId, { service: "billing-service", event: "promotion_codes.redeem.start", data: { code } }, req.headers);

  await findOrCreateAccount(orgId, userId, wfHeaders);

  let result;
  try {
    result = await redeemPromoCode(orgId, userId, code);
  } catch (err) {
    if (err instanceof PromoNotFoundError) {
      res.status(400).json({ error: "Invalid promo code" });
      return;
    }
    if (err instanceof PromoExpiredError) {
      res.status(400).json({ error: "Promo code has expired" });
      return;
    }
    if (err instanceof PromoExhaustedError) {
      res.status(400).json({ error: "Promo code has reached its redemption limit" });
      return;
    }
    if (err instanceof PromoAlreadyRedeemedError) {
      res.status(409).json({ error: "Promo code already redeemed by this organization" });
      return;
    }
    throw err;
  }

  const totalLocalCredits = await sumLocalPromoCreditsForOrg(orgId);

  traceEvent(
    runId,
    {
      service: "billing-service",
      event: "promotion_codes.redeem.done",
      data: { code, amount_cents: result.amountCents, total_local_credits_cents: totalLocalCredits },
    },
    req.headers
  );

  console.log(
    `[billing-service] Promo "${code}" redeemed by org ${orgId}: +$${(result.amountCents / 100).toFixed(2)}`
  );

  res.json({
    redeemed: true,
    amount_cents: String(result.amountCents),
    local_credits_total_cents: totalLocalCredits,
  });
});

export default router;
