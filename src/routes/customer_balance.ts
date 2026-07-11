import { Router } from "express";
import crypto from "crypto";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { AuthorizeRequestSchema, UsageApplyRequestSchema } from "../schemas.js";
import { sendEmail } from "../lib/email-client.js";
import { resolveRequiredCents } from "../lib/costs-client.js";
import { findOrCreateAccount } from "../lib/account.js";
import { traceEvent } from "../lib/trace-event.js";
import { addCents, subCents, gte as gteCents, parseNonNegativeCents } from "../lib/cents.js";
import { sumLocalPromoCreditsForOrg } from "../lib/promos.js";
import {
  getCustomerByOrg,
  sumSucceededTopupsForCustomer,
  hasAttachedCardPm,
  getOrgCardCountry,
  isAutoReloadBlockedCountry,
} from "../lib/stripe-service-client.js";
import { computeBalance } from "../lib/balance.js";
import { tierFor, computeTopupCharge, resolvePostpaidTier } from "../lib/topup-tier.js";
import { upsertCampaignAuthorizeCost } from "../lib/campaign-costs.js";
import { openDepletionEpisodeIfDepleted } from "../lib/dunning.js";
import { reloadViaPaymentIntent } from "../lib/reload.js";
import { coalesceReload } from "../lib/reload-coalescer.js";

const router = Router();

const RELOAD_TIMEOUT_MS = 30_000;
const RELOAD_IDEMPOTENCY_BUCKET_MS = 60_000;

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

router.post("/v1/customer_balance/authorize", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wf = getWorkflowHeaders(req);
    const wfHeaders = forwardWorkflowHeaders(wf);
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

    // Record this campaign's latest authorize cost (best estimate of its next
    // run's cost) for the read-only affordability pre-flight gate. Upserted on
    // both sufficient and insufficient outcomes; skipped for non-campaign
    // authorizes (no x-campaign-id, e.g. dashboard chats). Fail-loud — a write
    // failure surfaces, never silently drops the estimate. Does not touch the
    // reload / depletion control flow below.
    if (wf.campaignId) {
      await upsertCampaignAuthorizeCost(wf.campaignId, orgId, requiredCents);
    }

    const account = await findOrCreateAccount(orgId, userId, wfHeaders);

    let snapshot;
    try {
      snapshot = await computeBalance(orgId);
    } catch (err) {
      console.error("[billing-service] Failed to compute balance:", err);
      traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.compose-failed", level: "error", detail: String(err) }, req.headers);
      res.status(502).json({ error: "Failed to compute balance" });
      return;
    }

    // Threshold-based postpaid: the account is allowed to run NEGATIVE down to a
    // credit-line floor. The effective (amount, threshold) come from the derived
    // tier (a function of cumulative paid topups) — the stored columns are only
    // the "auto-topup enabled" flag. Orgs that can't be reloaded (no config, no
    // card, or a blocked issuing country) have no credit line → floor "0"
    // (strictly prepaid), so the sufficiency + dunning gates behave as before.
    const { tier, thresholdCents } = resolvePostpaidTier({
      topupEnabled: account.topupAmountCents != null,
      hasCardPm: snapshot.hasCardPm,
      autoReloadSupported: snapshot.autoReloadSupported,
      paidTopupsCents: snapshot.paidTopupsCents,
    });

    // Sufficient (no reload) when running this cost keeps the balance at/above
    // the floor: balance − required >= threshold. A negative balance still
    // within the credit line reads sufficient and runs on credit.
    if (gteCents(subCents(snapshot.balanceCents, requiredCents), thresholdCents)) {
      traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.done", data: { sufficient: true, balance_cents: snapshot.balanceCents, required_cents: requiredCents, threshold_cents: thresholdCents } }, req.headers);
      res.json({
        sufficient: true,
        balance_cents: snapshot.balanceCents,
        required_cents: requiredCents,
      });
      return;
    }

    if (!account.topupAmountCents) {
      await openDepletionEpisodeIfDepleted({
        orgId, userId, runId,
        balanceCents: snapshot.balanceCents,
        thresholdCents,
        creditedCents: snapshot.creditedCents,
        workflow: wf,
        workflowHeaders: wfHeaders,
        recipientEmail: snapshot.customer.email,
        autoReloadSupported: snapshot.autoReloadSupported,
      });
      traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.done", data: { sufficient: false, reason: "no_topup_config" } }, req.headers);
      res.json({
        sufficient: false,
        balance_cents: snapshot.balanceCents,
        required_cents: requiredCents,
      });
      return;
    }

    if (!snapshot.hasCardPm) {
      await openDepletionEpisodeIfDepleted({
        orgId, userId, runId,
        balanceCents: snapshot.balanceCents,
        thresholdCents,
        creditedCents: snapshot.creditedCents,
        workflow: wf,
        workflowHeaders: wfHeaders,
        recipientEmail: snapshot.customer.email,
        autoReloadSupported: snapshot.autoReloadSupported,
      });
      res.json({
        sufficient: false,
        balance_cents: snapshot.balanceCents,
        required_cents: requiredCents,
      });
      return;
    }

    if (!snapshot.autoReloadSupported) {
      // Card issued in a country that can't be charged off_session (e.g. India / RBI
      // e-mandate, issue #220). A reload here would be declined every cycle, so we skip
      // it and fall through to depletion dunning, which prompts a manual recharge.
      await openDepletionEpisodeIfDepleted({
        orgId, userId, runId,
        balanceCents: snapshot.balanceCents,
        thresholdCents,
        creditedCents: snapshot.creditedCents,
        workflow: wf,
        workflowHeaders: wfHeaders,
        recipientEmail: snapshot.customer.email,
        autoReloadSupported: snapshot.autoReloadSupported,
      });
      traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.done", data: { sufficient: false, reason: "auto_reload_unsupported_country", card_country: snapshot.cardCountry } }, req.headers);
      res.json({
        sufficient: false,
        balance_cents: snapshot.balanceCents,
        required_cents: requiredCents,
      });
      return;
    }

    // canReload is true here → tier is non-null. Reload enough tier-amount
    // multiples to bring the balance up to (threshold + required) so the run
    // clears WITH the floor headroom preserved. Charge uses the tier amount, not
    // the stored daily amount.
    const targetCents = addCents(thresholdCents, requiredCents);
    const chargeAmount = computeTopupCharge(snapshot.balanceCents, targetCents, tier!.amountCents);
    if (chargeAmount <= 0) {
      await openDepletionEpisodeIfDepleted({
        orgId, userId, runId,
        balanceCents: snapshot.balanceCents,
        thresholdCents,
        creditedCents: snapshot.creditedCents,
        workflow: wf,
        workflowHeaders: wfHeaders,
        recipientEmail: snapshot.customer.email,
        autoReloadSupported: snapshot.autoReloadSupported,
      });
      res.json({
        sufficient: false,
        balance_cents: snapshot.balanceCents,
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
      await openDepletionEpisodeIfDepleted({
        orgId, userId, runId,
        balanceCents: snapshot.balanceCents,
        thresholdCents,
        creditedCents: snapshot.creditedCents,
        workflow: wf,
        workflowHeaders: wfHeaders,
        recipientEmail: snapshot.customer.email,
        autoReloadSupported: snapshot.autoReloadSupported,
      });
      res.json({
        sufficient: false,
        balance_cents: snapshot.balanceCents,
        required_cents: requiredCents,
      });
      return;
    }

    let after;
    try {
      after = await computeBalance(orgId);
    } catch (err) {
      console.error("[billing-service] Failed to recompute balance after reload:", err);
      res.status(502).json({ error: "Failed to recompute balance after reload" });
      return;
    }

    const sufficient = gteCents(subCents(after.balanceCents, requiredCents), thresholdCents);
    if (!sufficient) {
      await openDepletionEpisodeIfDepleted({
        orgId, userId, runId,
        balanceCents: after.balanceCents,
        thresholdCents,
        creditedCents: after.creditedCents,
        workflow: wf,
        workflowHeaders: wfHeaders,
        recipientEmail: after.customer.email,
        autoReloadSupported: after.autoReloadSupported,
      });
    }

    traceEvent(runId, { service: "billing-service", event: "customer_balance.authorize.done", data: { sufficient, balance_cents: after.balanceCents, required_cents: requiredCents, reloaded_cents: chargeAmount } }, req.headers);

    res.json({
      sufficient,
      balance_cents: after.balanceCents,
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

    if (!(await hasAttachedCardPm(identity, customer.id))) {
      res.status(202).json({ acknowledged: true, topup_triggered: false });
      return;
    }

    // India (and other off_session-mandate) cards can't be auto-reloaded — Stripe declines
    // the off_session charge with no registered mandate (issue #220). Skip rather than spam
    // a doomed reload; the depletion dunning path prompts the org to recharge manually.
    if (isAutoReloadBlockedCountry(await getOrgCardCountry(identity, customer.id))) {
      traceEvent(runId, { service: "billing-service", event: "customer_balance.usage_apply.topup-skipped", data: { reason: "auto_reload_unsupported_country" } }, req.headers);
      res.status(202).json({ acknowledged: true, topup_triggered: false });
      return;
    }

    const [paidTopups, localCredits] = await Promise.all([
      sumSucceededTopupsForCustomer(identity, customer.id),
      sumLocalPromoCreditsForOrg(orgId),
    ]);

    const creditedCents = addCents(paidTopups, localCredits);
    // spent_total_cents is reported by runs-service after its cost write, so it is
    // already NET of any per-org usage discount (the discount is applied once, at
    // cost-write). Billing subtracts it verbatim — re-applying the discount here
    // would double-count it.
    const balanceCents = subCents(creditedCents, spentTotalCents);

    // Threshold-based postpaid: the effective (amount, threshold) come from the
    // derived tier (a function of cumulative paid topups), NOT the stored daily
    // columns. The floor is NEGATIVE, so a reload only fires once spend crosses
    // the credit line — not every day.
    const tier = tierFor(paidTopups);
    const thresholdCents = String(tier.thresholdCents);

    if (gteCents(balanceCents, thresholdCents)) {
      traceEvent(runId, { service: "billing-service", event: "customer_balance.usage_apply.no-topup", data: { balance_cents: balanceCents, threshold_cents: thresholdCents } }, req.headers);
      res.status(202).json({ acknowledged: true, topup_triggered: false });
      return;
    }

    const chargeAmount = computeTopupCharge(balanceCents, thresholdCents, tier.amountCents);
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
