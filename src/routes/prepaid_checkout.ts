import { Router } from "express";
import { isRealOrgId } from "../lib/org-id.js";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import {
  AgentApiSignupResponseSchema,
  CreatePrepaidCheckoutRequestSchema,
} from "../schemas.js";
import { markAgentApiOrg } from "../lib/agent-api-org.js";
import { ensureOrgStripeCustomer } from "../lib/account.js";
import { createCheckoutSession } from "../lib/stripe-service-client.js";
import { setPaymentMode, PaymentModeSwitchRefused } from "../lib/payment-mode.js";
import { recordPaymentConsent } from "../lib/payment-consents.js";
import { recordCheckoutOpened } from "../lib/payment-alerts.js";
import { notifyOwnerBillingEvent, usd } from "../lib/owner-alerts.js";
import { resolvePrepaidStatus } from "../lib/prepaid-status.js";
import { traceEvent } from "../lib/trace-event.js";
import {
  getOrgTopupMinimums,
  reloadRulesFor,
  topupMinimumsFor,
  TopupBelowMinimumError,
  type ReloadRules,
} from "../lib/free-credit-offer.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKOUT_PRODUCT_NAME = "Distribute credit top-up";
const CHECKOUT_CURRENCY = "usd";

// PUT /internal/accounts/by-org/:orgId/agent-api-signup
//
// client-service marks an org opened by an AI agent through the API, at
// provisioning, BEFORE anything else touches billing. From then on the org gets no
// free credit of any kind (lib/agent-api-org). Idempotent. Service-auth + orgId in
// the PATH only.
router.put("/internal/accounts/by-org/:orgId/agent-api-signup", async (req, res) => {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a valid UUID" });
    return;
  }
  if (!isRealOrgId(orgId)) {
    res.status(400).json({ error: "orgId must be a real org id, never a placeholder" });
    return;
  }
  try {
    const result = await markAgentApiOrg(orgId);
    const body = AgentApiSignupResponseSchema.parse({
      orgId,
      freeCreditOffer: result.account.freeCreditOffer,
      paymentMode: result.account.paymentMode,
      created: result.created,
      alreadyMarked: result.alreadyMarked,
      freeCreditHeldCents: result.freeCreditHeldCents,
    });
    res.json(body);
  } catch (err) {
    console.error(`[billing-service] agent-api-signup failed for org ${orgId}:`, err);
    res.status(500).json({ error: "Failed to mark the org as opened through the API" });
  }
});

// POST /v1/accounts/prepaid_checkout
//
// ONE call: a hosted payment page that charges the chosen prepay amount, saves the
// card for off-session reuse, with the org PREPAID and auto top-up armed at the
// chosen reload amount + threshold. The reload can only fire once the card that
// payment saves exists, so balance, card and working auto top-up all land with the
// payment. No subscription on this path.
router.post("/v1/accounts/prepaid_checkout", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));

    const parsed = CreatePrepaidCheckoutRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const {
      topup_amount_cents: topupAmountCents,
      auto_topup_amount_cents: statedReloadAmountCents,
      success_url,
      cancel_url,
      consent,
    } = parsed.data;


    // An org with no billing account yet is created WITHOUT any free credit: this
    // path is the API's, and a default (at-cost) account would hand it a $5
    // advance. An existing account keeps its own offer: the dashboard org of every
    // new signup (prepaid_at_cost) checks out here too, first top-up + reload in one step.
    let [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);
    if (!account) account = (await markAgentApiOrg(orgId)).account;

    // The reload rules live HERE, never in a caller (RELOAD-RULE-ONE-HOME-1118): an
    // absent reload is the owner's default (+$10 below $5), a stated one below the
    // minimums is refused, and so is a first payment under one reload.
    const rules = reloadRulesFor(topupMinimumsFor(account));
    const reloadAmountCents = statedReloadAmountCents ?? rules.defaultReloadAmountCents;
    // The threshold is $0 for everyone (owner 2026-11-18): a sent one is ignored.
    const reloadThresholdCents = rules.defaultReloadThresholdCents;
    const refusal = reloadRuleRefusal(rules, topupAmountCents, reloadAmountCents);
    if (refusal) {
      res.status(400).json(refusal);
      return;
    }
    traceEvent(runId, { service: "billing-service", event: "prepaid_checkout.start", data: { topupAmountCents, reloadAmountCents, reloadThresholdCents } }, req.headers);

    if (account.paymentMode === "subscription") {
      res.status(409).json({
        error: "This organization pays by subscription; prepaid checkout is not available.",
        code: "subscription_mode",
      });
      return;
    }

    if (consent) {
      await recordPaymentConsent({ orgId, req, context: "prepaid_checkout", consent });
    }

    // Prepaid first: a postpaid org that owes money settles it (or is refused) before
    // any page is handed out.
    try {
      await setPaymentMode(orgId, "prepaid", "customer");
    } catch (err) {
      if (err instanceof PaymentModeSwitchRefused) {
        res.status(409).json({ error: err.message, code: err.code, owed_cents: err.owedCents });
        return;
      }
      throw err;
    }

    const identity = { "x-org-id": orgId, "x-user-id": userId, "x-run-id": runId, ...wfHeaders };
    let session;
    try {
      const customer = await ensureOrgStripeCustomer(identity);
      session = await createCheckoutSession(identity, {
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: CHECKOUT_CURRENCY,
              product_data: { name: CHECKOUT_PRODUCT_NAME },
              unit_amount: topupAmountCents,
            },
            quantity: 1,
          },
        ],
        ...(customer ? { customer: customer.id } : {}),
        metadata: { org_id: orgId },
        // Saves the card for the automatic reloads this checkout arms.
        payment_intent_data: { metadata: { org_id: orgId }, setup_future_usage: "off_session" },
        invoice_creation: { enabled: true },
        success_url,
        cancel_url,
      });
    } catch (err) {
      console.error("[billing-service] prepaid checkout: createCheckoutSession failed:", err);
      res.status(502).json({ error: "Failed to create checkout session via stripe-service" });
      return;
    }

    const [updated] = await db
      .update(billingAccounts)
      .set({
        topupAmountCents: reloadAmountCents,
        topupThresholdCents: reloadThresholdCents,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.orgId, orgId))
      .returning();

    await recordCheckoutOpened(
      orgId,
      (req.headers["x-email"] as string | undefined) ?? null,
      topupAmountCents
    );
    notifyOwnerBillingEvent({
      orgId,
      emoji: "🤖",
      text: `Prepaid checkout opened: ${usd(topupAmountCents)} now, automatic reload adds ${usd(reloadAmountCents)} when the balance reaches $0`,
    });

    traceEvent(runId, { service: "billing-service", event: "prepaid_checkout.done", data: { session_id: session.session_id ?? session.id } }, req.headers);

    if (!session.url) {
      console.error("[billing-service] prepaid checkout: stripe-service returned no hosted url");
      res.status(502).json({ error: "Failed to create checkout session via stripe-service" });
      return;
    }

    res.json({
      url: session.url,
      session_id: session.session_id ?? session.id,
      org_id: orgId,
      payment_mode: "prepaid",
      free_credit_offer: updated.freeCreditOffer,
      topup_amount_cents: topupAmountCents,
      auto_topup: {
        amount_cents: reloadAmountCents,
        threshold_cents: reloadThresholdCents,
      },
    });
  } catch (err) {
    console.error("[billing-service] Error creating prepaid checkout:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

function reloadRuleRefusal(
  rules: ReloadRules,
  topupCents: number,
  reloadCents: number
): { error: string; code: string; minimum_cents: number } | null {
  if (topupCents < rules.firstTopupMinimumCents) {
    const e = new TopupBelowMinimumError("topup_below_minimum", rules.firstTopupMinimumCents);
    return { error: e.message, code: e.code, minimum_cents: e.minimumCents };
  }
  if (reloadCents < rules.reloadAmountMinimumCents) {
    return {
      error: `An automatic reload must add at least $${(rules.reloadAmountMinimumCents / 100).toFixed(2)}`,
      code: "reload_below_minimum",
      minimum_cents: rules.reloadAmountMinimumCents,
    };
  }
  return null;
}

function reloadRulesBody(orgId: string, rules: ReloadRules) {
  return {
    org_id: orgId,
    first_topup_minimum_cents: rules.firstTopupMinimumCents,
    reload_amount_minimum_cents: rules.reloadAmountMinimumCents,
    reload_threshold_minimum_cents: rules.reloadThresholdMinimumCents,
    default_reload_amount_cents: rules.defaultReloadAmountCents,
    default_reload_threshold_cents: rules.defaultReloadThresholdCents,
  };
}

// GET /v1/accounts/reload_rules  (+ /internal/accounts/by-org/:orgId/reload-rules)
//
// The ONE home of the prepaid reload figures (RELOAD-RULE-ONE-HOME-1118): the first
// payment minimum, the smallest reload amount + threshold, and the reload a caller
// gets when it states none. Callers show and validate THESE, never a constant of
// their own. Pure read; an org with no billing account yet reads a new org's rules.
router.get("/v1/accounts/reload_rules", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  try {
    res.json(reloadRulesBody(orgId, reloadRulesFor(await getOrgTopupMinimums(orgId))));
  } catch (err) {
    console.error(`[billing-service] reload rules failed for org ${orgId}:`, err);
    res.status(500).json({ error: "Failed to read the reload rules" });
  }
});

router.get("/internal/accounts/by-org/:orgId/reload-rules", async (req, res) => {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a valid UUID" });
    return;
  }
  try {
    res.json(reloadRulesBody(orgId, reloadRulesFor(await getOrgTopupMinimums(orgId))));
  } catch (err) {
    console.error(`[billing-service] reload rules failed for org ${orgId}:`, err);
    res.status(500).json({ error: "Failed to read the reload rules" });
  }
});

// GET /v1/accounts/prepaid_status
//
// Where the one-step prepaid checkout stands, in one answer the caller can act on:
// paid yet? card saved? can it be reloaded off-session? (lib/prepaid-status)
router.get("/v1/accounts/prepaid_status", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  try {
    const status = await resolvePrepaidStatus(orgId);
    if (!status) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }
    res.json(status);
  } catch (err) {
    console.error(`[billing-service] prepaid status failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to read the prepaid status" });
  }
});

export default router;
