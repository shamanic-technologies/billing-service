import { Router } from "express";
import { eq } from "drizzle-orm";
import crypto from "crypto";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { UpdateAutoTopupRequestSchema, WalletSetupRequestSchema } from "../schemas.js";
import { findOrCreateAccount, findOrCreateWalletAccount } from "../lib/account.js";
import { addCents, isDepleted, subCents } from "../lib/cents.js";
import { fetchRunsOrgActualUsageTotal, fetchRunsOrgUsageTotal } from "../lib/runs-client.js";
import { grantFirstLoadMatch, sumLocalPromoCreditsForOrg } from "../lib/promos.js";
import { reloadViaPaymentIntent } from "../lib/reload.js";
import {
  getCustomerByOrg,
  sumSucceededTopupsForCustomer,
  hasAttachedCardPm,
} from "../lib/stripe-service-client.js";

const router = Router();
const INITIAL_LOAD_TIMEOUT_MS = 30_000;
const INITIAL_LOAD_IDEMPOTENCY_BUCKET_MS = 60_000;

function buildIdentity(
  orgId: string,
  userId: string,
  runId: string | undefined,
  wfHeaders: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {
    "x-org-id": orgId,
    "x-user-id": userId,
    ...wfHeaders,
  };
  if (runId) out["x-run-id"] = runId;
  return out;
}

async function composeAccountFunds(
  orgId: string,
  identity: Record<string, string>
): Promise<{
  creditedCents: string;
  usageCents: string;
  balanceCents: string;
  actualBalanceCents: string;
  hasPaymentMethod: boolean;
}> {
  const customer = await getCustomerByOrg(identity);
  const [paidTopups, localCredits, runsUsage, actualRunsUsage, hasCardPm] = await Promise.all([
    sumSucceededTopupsForCustomer(identity, customer.id),
    sumLocalPromoCreditsForOrg(orgId),
    fetchRunsOrgUsageTotal(orgId, identity),
    fetchRunsOrgActualUsageTotal(orgId, identity),
    hasAttachedCardPm(identity, customer.id),
  ]);
  const creditedCents = addCents(paidTopups, localCredits);
  const balanceCents = subCents(creditedCents, runsUsage.spent_cents);
  const actualBalanceCents = subCents(creditedCents, actualRunsUsage.spent_cents);
  return {
    creditedCents,
    usageCents: runsUsage.spent_cents,
    balanceCents,
    actualBalanceCents,
    hasPaymentMethod: hasCardPm,
  };
}

function buildAccountResponse(
  account: typeof billingAccounts.$inferSelect,
  funds: {
    creditedCents: string;
    usageCents: string;
    balanceCents: string;
    actualBalanceCents: string;
    hasPaymentMethod: boolean;
  }
) {
  return {
    id: account.id,
    org_id: account.orgId,
    credited_cents: funds.creditedCents,
    usage_cents: funds.usageCents,
    balance_cents: funds.balanceCents,
    actual_balance_cents: funds.actualBalanceCents,
    topup_amount_cents: account.topupAmountCents,
    topup_threshold_cents: account.topupThresholdCents,
    has_payment_method: funds.hasPaymentMethod,
    has_auto_topup: account.topupAmountCents != null && account.topupThresholdCents != null && funds.hasPaymentMethod,
    created_at: account.createdAt.toISOString(),
    updated_at: account.updatedAt.toISOString(),
  };
}

function initialLoadIdempotencyKey(orgId: string, amountCents: number): string {
  const bucket = Math.floor(Date.now() / INITIAL_LOAD_IDEMPOTENCY_BUCKET_MS);
  return crypto
    .createHash("sha256")
    .update(`wallet_setup:${orgId}:${amountCents}:${bucket}`)
    .digest("hex")
    .slice(0, 32);
}

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`initial load timeout after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

router.get("/v1/accounts", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const identity = buildIdentity(orgId, userId, runId, wfHeaders);

    const account = await findOrCreateAccount(orgId, userId, wfHeaders);

    let funds;
    try {
      funds = await composeAccountFunds(orgId, identity);
    } catch (err) {
      console.error("[billing-service] Failed to compose account funds:", err);
      res.status(502).json({ error: "Failed to compose account funds" });
      return;
    }

    res.json(buildAccountResponse(account, funds));
  } catch (err) {
    console.error("[billing-service] Error getting/creating account:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/accounts/balance", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const identity = buildIdentity(orgId, userId, runId, wfHeaders);

    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    if (!account) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }

    let funds;
    try {
      funds = await composeAccountFunds(orgId, identity);
    } catch (err) {
      console.error("[billing-service] Failed to compose account funds:", err);
      res.status(502).json({ error: "Failed to compose account funds" });
      return;
    }

    res.json({
      balance_cents: funds.balanceCents,
      actual_balance_cents: funds.actualBalanceCents,
      depleted: isDepleted(funds.balanceCents),
    });
  } catch (err) {
    console.error("[billing-service] Error checking balance:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/v1/accounts/auto_topup", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const identity = buildIdentity(orgId, userId, runId, wfHeaders);

    const parsed = UpdateAutoTopupRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { topup_amount_cents, topup_threshold_cents } = parsed.data;

    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    if (!account) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }

    let hasCardPm: boolean;
    try {
      const customer = await getCustomerByOrg(identity);
      hasCardPm = await hasAttachedCardPm(identity, customer.id);
    } catch (err) {
      console.error("[billing-service] Failed to fetch customer for PM check:", err);
      res.status(502).json({ error: "Failed to query payment method status" });
      return;
    }

    if (!hasCardPm) {
      res.status(400).json({
        error: "Payment method required. Create a checkout session first.",
      });
      return;
    }

    const [updated] = await db
      .update(billingAccounts)
      .set({
        topupAmountCents: topup_amount_cents,
        topupThresholdCents: topup_threshold_cents,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.orgId, orgId))
      .returning();

    let funds;
    try {
      funds = await composeAccountFunds(orgId, identity);
    } catch (err) {
      console.error("[billing-service] Failed to compose account funds:", err);
      res.status(502).json({ error: "Failed to compose account funds" });
      return;
    }

    res.json(buildAccountResponse(updated, funds));
  } catch (err) {
    console.error("[billing-service] Error updating auto-topup:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/v1/accounts/wallet_setup", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const identity = buildIdentity(orgId, userId, runId, wfHeaders);

    const parsed = WalletSetupRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const {
      initial_load_amount_cents,
      topup_amount_cents,
      topup_threshold_cents,
    } = parsed.data;

    await findOrCreateWalletAccount(orgId, userId, wfHeaders);

    let customer;
    let hasCardPm: boolean;
    try {
      customer = await getCustomerByOrg(identity);
      hasCardPm = await hasAttachedCardPm(identity, customer.id);
    } catch (err) {
      console.error("[billing-service] wallet_setup PM check failed:", err);
      res.status(502).json({ error: "Failed to query payment method status" });
      return;
    }

    if (!hasCardPm) {
      res.status(400).json({
        error: "Payment method required. Create a setup checkout session first.",
      });
      return;
    }

    let initialLoad;
    try {
      initialLoad = await withTimeout(
        INITIAL_LOAD_TIMEOUT_MS,
        reloadViaPaymentIntent(
          identity,
          initial_load_amount_cents,
          initialLoadIdempotencyKey(orgId, initial_load_amount_cents),
          { org_id: orgId, billing_reason: "initial_load" }
        )
      );
    } catch (err) {
      console.error("[billing-service] wallet_setup initial load failed:", err);
      res.status(502).json({ error: "Initial load via stripe-service failed" });
      return;
    }

    if (initialLoad.status !== "succeeded") {
      res.status(402).json({
        error: "Initial load payment failed",
        failure_reason: initialLoad.failure_reason ?? "payment_intent_not_succeeded",
      });
      return;
    }

    const [updated] = await db
      .update(billingAccounts)
      .set({
        topupAmountCents: topup_amount_cents,
        topupThresholdCents: topup_threshold_cents,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.orgId, orgId))
      .returning();

    const match = await grantFirstLoadMatch(orgId, userId, initial_load_amount_cents);

    let funds;
    try {
      funds = await composeAccountFunds(orgId, identity);
    } catch (err) {
      console.error("[billing-service] Failed to compose account funds:", err);
      res.status(502).json({ error: "Failed to compose account funds" });
      return;
    }

    res.json({
      ...buildAccountResponse(updated, funds),
      initial_load_amount_cents,
      initial_load_payment_intent_id: initialLoad.payment_intent_id,
      first_load_match_applied: match.applied,
      first_load_match_cents: match.amountCents,
      first_load_match_local_promo_id: match.localPromoId,
    });
  } catch (err) {
    console.error("[billing-service] Error setting up wallet:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/v1/accounts/auto_topup", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const identity = buildIdentity(orgId, userId, runId, wfHeaders);

    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    if (!account) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }

    const [updated] = await db
      .update(billingAccounts)
      .set({
        topupAmountCents: null,
        topupThresholdCents: null,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.orgId, orgId))
      .returning();

    let funds;
    try {
      funds = await composeAccountFunds(orgId, identity);
    } catch (err) {
      console.error("[billing-service] Failed to compose account funds:", err);
      res.status(502).json({ error: "Failed to compose account funds" });
      return;
    }

    res.json(buildAccountResponse(updated, funds));
  } catch (err) {
    console.error("[billing-service] Error disabling auto-topup:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
