import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  billingAccounts,
  WELCOME_COMPLETION_LAUNCH_AT_UNIX,
} from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { UpdateAutoTopupRequestSchema } from "../schemas.js";
import { findOrCreateAccount } from "../lib/account.js";
import { addCents, isDepleted, subCents } from "../lib/cents.js";
import { tierFor } from "../lib/topup-tier.js";
import { fetchRunsOrgActualUsageTotal, fetchRunsOrgUsageTotal } from "../lib/runs-client.js";
import { sumLocalPromoCreditsForOrg } from "../lib/promos.js";
import { settleFreeCreditPromises } from "../lib/free-credit-settlement.js";
import { getUsageDiscountPct } from "../lib/usage-discount.js";
import {
  getCustomerByOrg,
  sumSucceededTopupsForCustomer,
  sumSucceededTopupsForCustomerBefore,
  hasAttachedCardPm,
  getOrgCardCountry,
  getOrgCardDisplay,
  isAutoReloadBlockedCountry,
} from "../lib/stripe-service-client.js";

const router = Router();

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
  discountPct: number | null;
  paidTopupsCents: string;
  giftedCreditsCents: string;
  hasPaymentMethod: boolean;
  cardCountry: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  autoReloadSupported: boolean;
}> {
  const customer = await getCustomerByOrg(identity);
  const [paidTopups, localCreditsBeforeSettle, runsUsage, actualRunsUsage, hasCardPm, cardDisplay, discountPct] =
    await Promise.all([
      sumSucceededTopupsForCustomer(identity, customer.id),
      sumLocalPromoCreditsForOrg(orgId),
      fetchRunsOrgUsageTotal(orgId, identity),
      fetchRunsOrgActualUsageTotal(orgId, identity),
      hasAttachedCardPm(identity, customer.id),
      getOrgCardDisplay(identity, customer.id),
      getUsageDiscountPct(orgId),
    ]);
  // Free-credit promises (welcome + referral): paid topups are the trigger for all
  // of them and we already hold the figure, so settle here — the dashboard reads this
  // endpoint right after a payment, which is what makes a gift land in seconds rather
  // than waiting for the hourly sweep. Every grant condition is derived entirely from
  // Stripe's record of money received, never from anything the caller asserts. Fails
  // loud (→ 502 at the call site). Fold the freshly-granted total in rather than
  // re-querying the ledger.
  const settled = await settleFreeCreditPromises(orgId, paidTopups, () =>
    sumSucceededTopupsForCustomerBefore(
      identity,
      customer.id,
      WELCOME_COMPLETION_LAUNCH_AT_UNIX
    )
  );
  const localCredits = addCents(localCreditsBeforeSettle, settled.grantedCents);
  const cardCountry = cardDisplay?.country ?? null;
  const creditedCents = addCents(paidTopups, localCredits);
  // runs-service usage is already NET of the org's usage discount (frozen at
  // cost-write). Billing subtracts it verbatim — no discount is applied here. The
  // discount pct is still read + exposed (usage_discount_pct) for the dashboard
  // banner, but it does NOT change these balance figures.
  const balanceCents = subCents(creditedCents, runsUsage.spent_cents);
  const actualBalanceCents = subCents(creditedCents, actualRunsUsage.spent_cents);
  return {
    creditedCents,
    usageCents: runsUsage.spent_cents,
    balanceCents,
    actualBalanceCents,
    discountPct,
    paidTopupsCents: paidTopups,
    giftedCreditsCents: localCredits,
    hasPaymentMethod: hasCardPm,
    cardCountry,
    cardBrand: cardDisplay?.brand ?? null,
    cardLast4: cardDisplay?.last4 ?? null,
    cardExpMonth: cardDisplay?.expMonth ?? null,
    cardExpYear: cardDisplay?.expYear ?? null,
    autoReloadSupported: !isAutoReloadBlockedCountry(cardCountry),
  };
}

function buildAccountResponse(
  account: typeof billingAccounts.$inferSelect,
  funds: {
    creditedCents: string;
    usageCents: string;
    balanceCents: string;
    actualBalanceCents: string;
    discountPct: number | null;
    paidTopupsCents: string;
    giftedCreditsCents: string;
    hasPaymentMethod: boolean;
    cardCountry: string | null;
    cardBrand: string | null;
    cardLast4: string | null;
    cardExpMonth: number | null;
    cardExpYear: number | null;
    autoReloadSupported: boolean;
  }
) {
  // Auto-topup is enabled iff the stored columns are non-null (they are the
  // enabled flag). When enabled, the effective (amount, threshold) are the
  // DERIVED postpaid tier (a function of cumulative paid topups) — the negative
  // threshold is the credit-line floor the dashboard renders. When disabled,
  // both fields are null (no top-up). See lib/topup-tier.
  const enabled =
    account.topupAmountCents != null && account.topupThresholdCents != null;
  const tier = enabled ? tierFor(funds.paidTopupsCents) : null;
  return {
    id: account.id,
    org_id: account.orgId,
    credited_cents: funds.creditedCents,
    // Decomposition of credited_cents into the two things it is made of, so the
    // dashboard can render "money you paid" vs "credits we gave you" without doing
    // any money arithmetic in the browser. Invariant:
    //   credited_cents === credited_paid_cents + credited_gifted_cents
    // paid = succeeded Stripe payments NET of refunds + lost disputes.
    // gifted = SUM(local_promos): welcome, welcome-completion, first-load match,
    // invite grants, staff grants, redeemed promo codes.
    credited_paid_cents: funds.paidTopupsCents,
    credited_gifted_cents: funds.giftedCreditsCents,
    usage_cents: funds.usageCents,
    balance_cents: funds.balanceCents,
    actual_balance_cents: funds.actualBalanceCents,
    // Per-org platform-usage discount percentage (0–100), or null when none. This
    // is EXPOSED for the customer dashboard banner only — it does NOT affect the
    // balance figures above. The discount is applied ONCE, at cost-write time, in
    // runs-service, so usage_cents (and thus balance_cents/actual_balance_cents) is
    // already net. Billing never re-applies it. See CLAUDE.md "Usage discount".
    usage_discount_pct: funds.discountPct,
    topup_amount_cents: tier ? tier.amountCents : null,
    topup_threshold_cents: tier ? tier.thresholdCents : null,
    has_payment_method: funds.hasPaymentMethod,
    // Off_session auto-reload is impossible for cards issued in mandate-required countries
    // (e.g. India / RBI, issue #220). When unsupported, the dashboard shows a notice and
    // has_auto_topup is false even if topup config exists — the reload would never fire.
    auto_reload_supported: funds.autoReloadSupported,
    auto_reload_unsupported_reason: funds.autoReloadSupported ? null : "card_issuing_country_unsupported",
    card_country: funds.cardCountry,
    // Non-sensitive human-facing display attributes of the saved card, so the
    // dashboard can render it like a real billing UI ("Visa ending 4242, expires
    // 08/27"). Null when the org has no card PM (link-only / none) — never
    // fabricated. Display-only: brand, last4, expiry — NEVER the full PAN.
    card_brand: funds.cardBrand,
    card_last4: funds.cardLast4,
    card_exp_month: funds.cardExpMonth,
    card_exp_year: funds.cardExpYear,
    has_auto_topup:
      account.topupAmountCents != null &&
      account.topupThresholdCents != null &&
      funds.hasPaymentMethod &&
      funds.autoReloadSupported,
    created_at: account.createdAt.toISOString(),
    updated_at: account.updatedAt.toISOString(),
  };
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
    let cardCountry: string | null;
    try {
      const customer = await getCustomerByOrg(identity);
      [hasCardPm, cardCountry] = await Promise.all([
        hasAttachedCardPm(identity, customer.id),
        getOrgCardCountry(identity, customer.id),
      ]);
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

    // Off_session auto-reload can't be charged for cards issued in mandate-required
    // countries (e.g. India / RBI, issue #220). Reject the config rather than store one
    // that silently never fires — fail loud so the dashboard surfaces the real reason.
    if (isAutoReloadBlockedCountry(cardCountry)) {
      res.status(400).json({
        error: `Auto-reload is unavailable for cards issued in ${cardCountry} — off-session charges require a mandate Stripe can't register on this card. Add a card from another country to enable auto-reload.`,
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
