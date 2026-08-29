import { Router } from "express";
import {
  requireOrgHeaders,
  getWorkflowHeaders,
  forwardWorkflowHeaders,
} from "../middleware/auth.js";
import { ReferralClaimRequestSchema } from "../schemas.js";
import {
  getCustomerByOrg,
  sumSucceededTopupsForCustomer,
} from "../lib/stripe-service-client.js";
import {
  attachReferredOrgIdentities,
  claimReferral,
  listOutstandingPromises,
  sumOutstandingPromiseAmounts,
  ReferralAlreadyClaimedError,
  ReferralRewardCodeMissingError,
  SelfReferralError,
  type FreeCreditPromiseView,
} from "../lib/free-credit-promises.js";
import { settleFreeCreditPromises } from "../lib/free-credit-settlement.js";

const router = Router();

// POST /internal/referrals/claim — client-service tells billing that a new org
// signed up through another org's invite link.
//
// Auth: x-api-key only (both org ids are in the body; no x-org-id header). Opens the
// INVITEE's outstanding referral promise and remembers who referred them; grants
// NOTHING (the referral offer has no up-front portion, the whole amount lands when
// the bar is crossed). The inviter's own promise is opened later, at the moment the
// invitee EARNS theirs — never from the invitee merely signing up.
//
// Idempotent: re-claiming the same invite returns the existing promise with
// alreadyClaimed=true. A claim by a DIFFERENT inviter is a 409 — an org is referred
// once, and guessing which inviter wins is not billing's call.
router.post("/internal/referrals/claim", async (req, res) => {
  const parsed = ReferralClaimRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const { orgId, referrerOrgId } = parsed.data;

  try {
    const { promise, alreadyClaimed } = await claimReferral(orgId, referrerOrgId);
    console.log(
      `[billing-service] referral claim: org=${orgId} referrer=${referrerOrgId} ` +
        `promise=${promise.id} amount_cents=${promise.amountCents} ` +
        `bar_cents=${promise.paidTriggerCents} already=${alreadyClaimed}`
    );
    res.json({
      ok: true as const,
      alreadyClaimed,
      promise: {
        id: promise.id,
        orgId: promise.orgId,
        kind: promise.kind,
        amountCents: promise.amountCents,
        paidTriggerCents: promise.paidTriggerCents,
        referrerOrgId: promise.referrerOrgId,
        referredOrgId: promise.referredOrgId,
        grantedAt: promise.grantedAt ? promise.grantedAt.toISOString() : null,
        createdAt: promise.createdAt.toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof SelfReferralError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof ReferralAlreadyClaimedError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof ReferralRewardCodeMissingError) {
      // Fail loud, exactly like the welcome-completion seed: a promise we cannot
      // ever grant must not be recorded as if we could.
      console.error("[billing-service] referral claim seed missing:", err);
      res.status(500).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// GET /v1/free-credit-promises — every free-credit promise this org is still
// waiting on, for the customer dashboard (through the api-service gateway).
//
// Per promise: what it is worth, what unlocks it, how far along the org is, and —
// when the promise exists because someone they referred converted — WHICH org that
// was, by name and domain (`referred_org_name` / `referred_org_domain`), so three
// pending $500s do not render as three identical rows. billing resolves that itself:
// it is the only service that knows the referral relationship exists, and that
// relationship is what authorizes revealing anything about the other org at all.
// The identity is fail-soft — it is absent or null, never fabricated, and never
// takes the amounts down with it.
//
// Settles first, so a customer coming back from Stripe sees an already-earned grant
// land immediately. That can only make an earned grant land SOONER: every condition
// is derived from Stripe's record of money received plus billing's own ledger, so
// nothing the browser sends can conjure one.
router.get("/v1/free-credit-promises", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const identity: Record<string, string> = {
      "x-org-id": orgId,
      "x-user-id": userId,
      ...wfHeaders,
    };
    if (runId) identity["x-run-id"] = runId;

    let promises: FreeCreditPromiseView[];
    let paidTopupsCents: string;
    try {
      const customer = await getCustomerByOrg(identity);
      paidTopupsCents = await sumSucceededTopupsForCustomer(identity, customer.id);
      await settleFreeCreditPromises(orgId, paidTopupsCents);
      promises = await attachReferredOrgIdentities(
        await listOutstandingPromises(orgId, paidTopupsCents)
      );
    } catch (err) {
      console.error("[billing-service] Failed to compose free-credit promises:", err);
      res.status(502).json({ error: "Failed to compose free-credit promises" });
      return;
    }

    // outstanding_total_cents is ADDITIVE: a consumer that does not know about it
    // keeps working unchanged. It is summed from the very rows returned alongside
    // it, in the same money units and on the same basis, so the headline and the
    // list can never state different figures — and it is not spendable money (see
    // sumOutstandingPromiseAmounts).
    res.json({
      org_id: orgId,
      paid_topups_cents: paidTopupsCents,
      outstanding_total_cents: sumOutstandingPromiseAmounts(promises),
      promises,
    });
  } catch (err) {
    console.error("[billing-service] Error listing free-credit promises:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
