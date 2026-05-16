import { Router } from "express";
import { Decimal } from "decimal.js";
import crypto from "crypto";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { AuthorizeRequestSchema, UsageApplyRequestSchema } from "../schemas.js";
import { sendEmail } from "../lib/email-client.js";
import { resolveRequiredCents } from "../lib/costs-client.js";
import { findOrCreateAccount } from "../lib/account.js";
import { traceEvent } from "../lib/trace-event.js";
import { fetchRunsOrgUsageTotal } from "../lib/runs-client.js";
import { addCents, subCents, gte as gteCents, parseNonNegativeCents } from "../lib/cents.js";
import { sumLocalPromoCreditsForOrg } from "../lib/promos.js";
import {
  getCustomerByOrg,
  sumSucceededTopupsForCustomer,
  deriveHasPaymentMethod,
  type StripeCustomer,
} from "../lib/stripe-service-client.js";
import { reloadViaPaymentIntent } from "../lib/reload.js";
import { coalesceReload } from "../lib/reload-coalescer.js";

const router = Router();

const RELOAD_TIMEOUT_MS = 30_000;
const RELOAD_IDEMPOTENCY_BUCKET_MS = 60_000;

function computeTopupCharge(currentAvailable: string, requiredCents: string, topupUnit: number): number {
  const deficit = new Decimal(requiredCents).minus(currentAvailable);
  if (deficit.lessThanOrEqualTo(0)) return 0;
  const multiples = deficit.dividedBy(topupUnit).toDecimalPlaces(0, Decimal.ROUND_CEIL).toNumber();
  return multiples * topupUnit;
}

function buildIdentity(orgId: string, userId: string, runId: string | undefined, wfHeaders: Record<string, string>) {
  const out: Record<string, string> = {
    "x-org-id": orgId,
    "x-user-id": userId,
    ...wfHeaders,
  };
  if (runId) out["x-run-id"] = runId;
  return out;
}

function reloadIdempotencyKey(orgId: string, amountCents: number): string {
  const bucket = Math.floor(Date.now() / RELOAD_IDEMPOTENCY_BUCKET_MS);
  return crypto
    .createHash("sha256")
    .update(`topup:${orgId}:${amountCents}:${bucket}`)
    .digest("hex")
    .slice(0, 32);
}

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`reload timeout after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

interface AvailableSnapshot {
  customer: StripeCustomer;
  balanceCents: string;
  usageCents: string;
  availableCents: string;
}

async function computeAvailable(
  orgId: string,
  identity: Record<string, string>
): Promise<AvailableSnapshot> {
  const customer = await getCustomerByOrg(identity);
  const [paidTopups, localCredits, runsUsage] = await Promise.all([
    sumSucceededTopupsForCustomer(identity, customer.id),
    sumLocalPromoCreditsForOrg(orgId),
    fetchRunsOrgUsageTotal(orgId, identity),
  ]);
  const balanceCents = addCents(paidTopups, localCredits);
  const availableCents = subCents(balanceCents, runsUsage.spent_cents);
  return { customer, balanceCents, usageCents: runsUsage.spent_cents, availableCents };
}

router.post("/v1/customer_balance/authorize", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const identity = buildIdentity(orgId, userId, runId, wfHeaders);

    const parsed = AuthorizeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { items } = parsed.data;

    traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.start", data: { item_count: items.length } }, req.headers);

    let requiredCents: string;
    try {
      requiredCents = await resolveRequiredCents(items, identity);
    } catch (costErr) {
      traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.costs-failed", level: "error", detail: String(costErr) }, req.headers);
      console.error("[billing-service] Failed to resolve prices from costs-service:", costErr);
      res.status(502).json({ error: "Failed to resolve prices from costs-service" });
      return;
    }

    traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.resolved", data: { required_cents: requiredCents } }, req.headers);

    const account = await findOrCreateAccount(orgId, userId, wfHeaders);

    let available;
    try {
      available = await computeAvailable(orgId, identity);
    } catch (err) {
      console.error("[billing-service] Failed to compute available funds:", err);
      traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.compose-failed", level: "error", detail: String(err) }, req.headers);
      res.status(502).json({ error: "Failed to compute available funds" });
      return;
    }

    if (gteCents(available.availableCents, requiredCents)) {
      traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.done", data: { sufficient: true, balance_cents: available.availableCents, required_cents: requiredCents } }, req.headers);
      res.json({
        sufficient: true,
        balance_cents: available.availableCents,
        required_cents: requiredCents,
      });
      return;
    }

    if (!account.topupAmountCents) {
      sendEmail({ eventType: "credits-depleted", orgId, userId, runId, workflowHeaders: wfHeaders });
      traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.done", data: { sufficient: false, reason: "no_topup_config" } }, req.headers);
      res.json({
        sufficient: false,
        balance_cents: available.availableCents,
        required_cents: requiredCents,
      });
      return;
    }

    if (!deriveHasPaymentMethod(available.customer)) {
      sendEmail({ eventType: "credits-depleted", orgId, userId, runId, workflowHeaders: wfHeaders });
      res.json({
        sufficient: false,
        balance_cents: available.availableCents,
        required_cents: requiredCents,
      });
      return;
    }

    const chargeAmount = computeTopupCharge(available.availableCents, requiredCents, account.topupAmountCents);
    if (chargeAmount <= 0) {
      res.json({
        sufficient: false,
        balance_cents: available.availableCents,
        required_cents: requiredCents,
      });
      return;
    }

    let reloadResult;
    try {
      reloadResult = await coalesceReload(orgId, () =>
        withTimeout(
          RELOAD_TIMEOUT_MS,
          reloadViaPaymentIntent(identity, chargeAmount, reloadIdempotencyKey(orgId, chargeAmount))
        )
      );
    } catch (err) {
      console.error("[billing-service] reload via PaymentIntent failed:", err);
      traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.reload-errored", level: "error", detail: String(err) }, req.headers);
      sendEmail({ eventType: "credits-reload-failed", orgId, userId, runId, workflowHeaders: wfHeaders });
      res.status(502).json({ error: "Reload via stripe-service failed" });
      return;
    }

    if (reloadResult.status !== "succeeded") {
      console.warn(`[billing-service] reload status=${reloadResult.status} for org ${orgId}: ${reloadResult.failure_reason ?? ""}`);
      sendEmail({ eventType: "credits-reload-failed", orgId, userId, runId, workflowHeaders: wfHeaders });
      res.json({
        sufficient: false,
        balance_cents: available.availableCents,
        required_cents: requiredCents,
      });
      return;
    }

    let after;
    try {
      after = await computeAvailable(orgId, identity);
    } catch (err) {
      console.error("[billing-service] Failed to recompute available after reload:", err);
      res.status(502).json({ error: "Failed to recompute available funds after reload" });
      return;
    }

    const sufficient = gteCents(after.availableCents, requiredCents);
    if (!sufficient) {
      sendEmail({ eventType: "credits-depleted", orgId, userId, runId, workflowHeaders: wfHeaders });
    }

    traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.done", data: { sufficient, balance_cents: after.availableCents, required_cents: requiredCents, reloaded_cents: chargeAmount } }, req.headers);

    res.json({
      sufficient,
      balance_cents: after.availableCents,
      required_cents: requiredCents,
    });
  } catch (err) {
    console.error("[billing-service] Error authorizing customer balance:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/v1/customer_balance/usage_apply", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const identity = buildIdentity(orgId, userId, runId, wfHeaders);

    const parsed = UsageApplyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    let spentTotalCents: string;
    try {
      spentTotalCents = parseNonNegativeCents(parsed.data.spent_total_cents);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "invalid spent_total_cents" });
      return;
    }

    traceEvent(runId, { service: "billing-service", event: "customer_balance.usage_apply.start", data: { spent_total_cents: spentTotalCents } }, req.headers);

    const account = await findOrCreateAccount(orgId, userId, wfHeaders);

    if (!account.topupAmountCents || account.topupThresholdCents == null) {
      traceEvent(runId, { service: "billing-service", event: "customer_balance.usage_apply.no-topup-config" }, req.headers);
      res.status(202).json({ acknowledged: true, topup_triggered: false });
      return;
    }

    const customer = await getCustomerByOrg(identity);

    if (!deriveHasPaymentMethod(customer)) {
      res.status(202).json({ acknowledged: true, topup_triggered: false });
      return;
    }

    const [paidTopups, localCredits] = await Promise.all([
      sumSucceededTopupsForCustomer(identity, customer.id),
      sumLocalPromoCreditsForOrg(orgId),
    ]);

    const balanceCents = addCents(paidTopups, localCredits);
    const availableCents = subCents(balanceCents, spentTotalCents);
    const thresholdCents = String(account.topupThresholdCents);

    if (gteCents(availableCents, thresholdCents)) {
      traceEvent(runId, { service: "billing-service", event: "customer_balance.usage_apply.no-topup", data: { available_cents: availableCents, threshold_cents: thresholdCents } }, req.headers);
      res.status(202).json({ acknowledged: true, topup_triggered: false });
      return;
    }

    const chargeAmount = computeTopupCharge(availableCents, thresholdCents, account.topupAmountCents);
    if (chargeAmount <= 0) {
      res.status(202).json({ acknowledged: true, topup_triggered: false });
      return;
    }

    let topupTriggered = false;
    try {
      const result = await coalesceReload(orgId, () =>
        withTimeout(
          RELOAD_TIMEOUT_MS,
          reloadViaPaymentIntent(identity, chargeAmount, reloadIdempotencyKey(orgId, chargeAmount))
        )
      );
      topupTriggered = result.status === "succeeded";
      if (!topupTriggered) {
        console.warn(`[billing-service] usage_apply reload status=${result.status} for org ${orgId}`);
      }
    } catch (err) {
      console.error("[billing-service] usage_apply reload errored:", err);
    }

    traceEvent(runId, { service: "billing-service", event: topupTriggered ? "customer_balance.usage_apply.topup-fired" : "customer_balance.usage_apply.topup-skipped" }, req.headers);
    res.status(202).json({ acknowledged: true, topup_triggered: topupTriggered });
  } catch (err) {
    console.error("[billing-service] Error in usage_apply:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
