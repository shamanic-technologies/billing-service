import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { CreateCheckoutRequestSchema } from "../schemas.js";
import { createCheckoutSession } from "../lib/stripe-service-client.js";
import { findOrCreateAccount } from "../lib/account.js";
import { traceEvent } from "../lib/trace-event.js";

const router = Router();

// POST /v1/checkout-sessions — create Stripe Checkout session via stripe-service.
router.post("/v1/checkout-sessions", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));

    const parsed = CreateCheckoutRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { success_url, cancel_url, topup_amount_cents } = parsed.data;

    traceEvent(runId, { service: "billing-service", event: "checkout.start", data: { topup_amount_cents } }, req.headers);

    await findOrCreateAccount(orgId, userId, wfHeaders);

    let session;
    try {
      session = await createCheckoutSession(
        {
          "x-org-id": orgId,
          "x-user-id": userId,
          "x-run-id": runId,
          ...wfHeaders,
        },
        { success_url, cancel_url, topup_amount_cents }
      );
    } catch (err) {
      console.error("[billing-service] stripe-service createCheckoutSession failed:", err);
      res.status(502).json({ error: "Failed to create checkout session via stripe-service" });
      return;
    }

    await db
      .update(billingAccounts)
      .set({
        topupAmountCents: topup_amount_cents,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.orgId, orgId));

    traceEvent(runId, { service: "billing-service", event: "checkout.done", data: { session_id: session.session_id } }, req.headers);

    res.json({
      url: session.url,
      session_id: session.session_id,
    });
  } catch (err) {
    console.error("[billing-service] Error creating checkout session:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
