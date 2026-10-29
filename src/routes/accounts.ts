import { notifyOwnerBillingEvent, usd } from "../lib/owner-alerts.js";
import { cardFactsFrom, cardFactsWire } from "../lib/card-facts.js";
import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { AGENT_API_FREE_CREDIT_OFFER, AT_COST_FREE_CREDIT_OFFER, billingAccounts } from "../db/schema.js";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { CardSetupRequestSchema, UpdateAutoTopupRequestSchema } from "../schemas.js";
import { findOrCreateAccount, ensureOrgStripeCustomer } from "../lib/account.js";
import { addCents, cmpCents, isDepleted, subCents, ZERO_CENTS } from "../lib/cents.js";
import { autoTopupArmed, reloadTierFor } from "../lib/topup-tier.js";
import { PayBalanceRefused, payOutstandingBalance } from "../lib/pay-balance.js";
import { OnDemandChargeError } from "../lib/on-demand-charge.js";
import { asPaymentMode } from "../lib/payment-mode-types.js";
import {
  asFreeCreditOffer,
  assertAutoTopupMinimums,
  topupMinimumsFor,
  composeCreditedFromParts,
  computeFreeCreditStatus,
  getOnboardingAdvanceCents,
  getTrialAdvanceCents,
  getTrialRepaymentCents,
  configuredReloadFor,
  TopupBelowMinimumError,
} from "../lib/free-credit-offer.js";
import { fetchOrgActualUsageTotal, fetchOrgUsageTotal } from "../lib/transfer-usage.js";
import { sumEntitlementGrantsForOrg, sumLocalPromoCreditsForOrg } from "../lib/promos.js";
import { settleFreeCreditPromises } from "../lib/free-credit-settlement.js";
import { sumOffPlatformPaymentsForOrg } from "../lib/off-platform-payments.js";
import { getUsageDiscountPct } from "../lib/usage-discount.js";
import {
  settleOutstandingBeforeCardChange,
  settlementWireFields,
} from "../lib/card-change-settlement.js";
import { removeCardForOrg } from "../lib/card-removal.js";
import {
  getCustomerByOrgOrNull,
  sumSucceededTopupsForOrg,
  hasAttachedCardPm,
  hasChargeablePmForOrg,
  getOrgCardCountry,
  getOrgCardDisplay,
  isAutoReloadBlockedCountry,
  getCardSetup,
  getSavedPaymentMethod,
  authorizeRecurringCharges,
  LEGACY_PM_GATE_ACQUIRER,
} from "../lib/stripe-service-client.js";
import { errorReason } from "../lib/pg-error.js";

/**
 * Free credit this org can still spend: the smaller of what it was gifted and what it
 * can spend at all, never below zero. Gifted credit spent first or last, the org
 * cannot have more free credit left than either figure.
 */
export function spendableFreeCreditCents(giftedCents: string, balanceCents: string): string {
  const smaller = cmpCents(giftedCents, balanceCents) <= 0 ? giftedCents : balanceCents;
  return cmpCents(smaller, ZERO_CENTS) > 0 ? addCents(smaller, ZERO_CENTS) : ZERO_CENTS;
}

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
  debitedCents: string;
  expiredCents: string;
  balanceCents: string;
  actualBalanceCents: string;
  discountPct: number | null;
  paidTopupsCents: string;
  offPlatformPaidCents: string;
  giftedCreditsCents: string;
  entitlementGrantsCents: string;
  advanceCents: string;
  advanceRepaidCents: string;
  trialRepaidCents: string;
  trialAdvanceCents: string;
  hasPaymentMethod: boolean;
  cardCountry: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  autoReloadSupported: boolean;
}> {
  // An org with NO Stripe customer is an ordinary state, not a failure: an org
  // whose only money is a trial seed or a welcome gift has none, and neither does
  // an org paying through another acquirer (Revolut). Same "definite none, never
  // an outage" distinction as lib/balance's computeBalance; see
  // fetchOrgCustomerOrNull.
  //
  // Latency: this read sits on every dashboard page, so nothing waits on
  // anything it does not need. The runs-service usage reads, the promo sum and
  // the discount do not depend on the Stripe customer, so they start at once
  // instead of behind the customer lookup; only the three customer-dependent
  // Stripe reads chain on it. Same calls, same figures — only the ordering moved.
  //
  // Paid top-ups are ALWAYS asked, customer or not: stripe-service's payment
  // summary spans every acquirer and answers zero for an org that paid nothing.
  // An org paying through Revolut has NO Stripe customer by design, so gating
  // this on one made its completed top-ups vanish from credited_paid and the
  // balance. For the same reason an org without a Stripe customer asks the
  // acquirer-neutral card read (hasChargeablePmForOrg), which answers from
  // whichever acquirer holds the org's card; the Stripe-shaped display read
  // (brand, last4, expiry) stays Stripe-only — another acquirer does not state
  // them, and nothing is invented.
  const customerP = getCustomerByOrgOrNull(identity);
  const stripeP = customerP.then((customer) =>
    Promise.all([
      sumSucceededTopupsForOrg(orgId),
      customer ? hasAttachedCardPm(identity, customer.id) : hasChargeablePmForOrg(orgId),
      customer ? getOrgCardDisplay(identity, customer.id) : Promise.resolve(null),
    ])
  );
  const [
    [paidTopups, hasCardPm, cardDisplay],
    localCreditsBeforeSettle,
    runsUsage,
    actualRunsUsage,
    discountPct,
    offPlatformPaidCents,
  ] = await Promise.all([
    stripeP,
    sumLocalPromoCreditsForOrg(orgId),
    fetchOrgUsageTotal(orgId, identity),
    fetchOrgActualUsageTotal(orgId, identity),
    getUsageDiscountPct(orgId),
    // Staff grants the client PAID for off-platform (lib/off-platform-payments): cash,
    // not a gift. Only moves cash/paid vs gifted below; credited and balance are the
    // same local_promos rows either way.
    sumOffPlatformPaymentsForOrg(orgId),
  ]);
  // Free-credit promises (welcome + referral): paid topups are the trigger for all
  // of them and we already hold the figure, so settle here — the dashboard reads this
  // endpoint right after a payment, which is what makes a gift land in seconds rather
  // than waiting for the hourly sweep. Every grant condition is derived entirely from
  // Stripe's record of money received, never from anything the caller asserts. Fails
  // loud (→ 502 at the call site). Fold the freshly-granted total in rather than
  // re-querying the ledger.
  const settled = await settleFreeCreditPromises(orgId, paidTopups);
  const localCredits = addCents(localCreditsBeforeSettle, settled.grantedCents);
  // What counts toward the org's free-credit offer, read AFTER the settle so a gift
  // that just landed is in it (free_credit_received_cents).
  const entitlementGrantsCents = await sumEntitlementGrantsForOrg(orgId);
  const cardCountry = cardDisplay?.country ?? null;
  // A match_100 org's $30 onboarding advance is repaid by its payments, and shown
  // as its own line, never as a gift (lib/free-credit-offer).
  const advance = await getOnboardingAdvanceCents(orgId);
  // The trial-end subscription payment repays the trial credit: it adds none.
  const trialRepayment = await getTrialRepaymentCents(orgId);
  // The trial credit itself is an ADVANCE on the subscription, never free credit:
  // out of credited_gifted_cents, repaid or not, on its own line.
  const trialAdvance = await getTrialAdvanceCents(orgId);
  const creditParts = composeCreditedFromParts(paidTopups, localCredits, advance, trialRepayment);
  const creditedCents = creditParts.creditedCents;
  // runs-service usage is already NET of the org's usage discount (frozen at
  // cost-write). Billing subtracts it verbatim — no discount is applied here. The
  // discount pct is still read + exposed (usage_discount_pct) for the dashboard
  // banner, but it does NOT change these balance figures.
  const balanceCents = subCents(creditedCents, runsUsage.spent_cents);
  const actualBalanceCents = subCents(creditedCents, actualRunsUsage.spent_cents);
  return {
    creditedCents,
    // Staff debits are included in the usage figure the balances subtract (they
    // lower the balance like spend), but they are NOT campaign usage: taken back out
    // here and shown as their own line, debited_cents. See lib/staff-debits.
    // Expired subscription credit (lib/subscription) rides the same choke point
    // and is shown as its own line too, expired_cents.
    usageCents: subCents(
      subCents(runsUsage.spent_cents, runsUsage.staff_debits_cents),
      runsUsage.subscription_expired_cents
    ),
    debitedCents: runsUsage.staff_debits_cents,
    expiredCents: runsUsage.subscription_expired_cents,
    balanceCents,
    actualBalanceCents,
    discountPct,
    paidTopupsCents: paidTopups,
    offPlatformPaidCents,
    giftedCreditsCents: subCents(
      subCents(subCents(localCredits, creditParts.advanceCents), trialAdvance),
      offPlatformPaidCents
    ),
    entitlementGrantsCents,
    advanceCents: creditParts.advanceCents,
    advanceRepaidCents: creditParts.advanceRepaidCents,
    trialRepaidCents: creditParts.trialRepaidCents,
    trialAdvanceCents: trialAdvance,
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
    debitedCents: string;
    expiredCents: string;
    balanceCents: string;
    actualBalanceCents: string;
    discountPct: number | null;
    paidTopupsCents: string;
    offPlatformPaidCents: string;
    giftedCreditsCents: string;
    entitlementGrantsCents: string;
    advanceCents: string;
    advanceRepaidCents: string;
    trialRepaidCents: string;
    trialAdvanceCents: string;
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
  const enabled = autoTopupArmed(account);
  const paymentMode = asPaymentMode(account.paymentMode);
  // A subscription org never reloads (lib/subscription): no tier, whatever a stale
  // stored flag says.
  // POSTPAID has no auto top-up (owner 2026-10-21): its line is served on
  // credit_line_* below, never as topup_* / has_auto_topup.
  const tier =
    enabled && paymentMode === "prepaid"
      ? reloadTierFor(funds.paidTopupsCents, paymentMode, configuredReloadFor(account))
      : null;
  const postpaidLine =
    paymentMode === "postpaid" && enabled && funds.hasPaymentMethod && funds.autoReloadSupported
      ? reloadTierFor(funds.paidTopupsCents, "postpaid")
      : null;
  const freeCredit = computeFreeCreditStatus({
    offer: asFreeCreditOffer(account.freeCreditOffer),
    entitlementCents: account.freeCreditEntitlementCents,
    paidTriggerCents: account.freeCreditPaidTriggerCents,
    eligible: account.welcomeCompletionEligible,
    receivedCents: funds.entitlementGrantsCents,
    paidTopupsCents: funds.paidTopupsCents,
  });
  return {
    id: account.id,
    org_id: account.orgId,
    // How this org pays — the customer's explicit choice. See lib/payment-mode.
    payment_mode: paymentMode,
    credited_cents: funds.creditedCents,
    // Decomposition of credited_cents into the two things it is made of, so the
    // dashboard can render "money you paid" vs "credits we gave you" without doing
    // any money arithmetic in the browser. Invariant:
    //   credited_cents === credited_paid_cents + credited_gifted_cents
    // paid = succeeded Stripe payments NET of refunds + lost disputes.
    // gifted = SUM(local_promos): welcome, welcome-completion, first-load match,
    // invite grants, staff grants, redeemed promo codes.
    // A match_100 org: the part of its payments left after repaying its onboarding
    // advance ($200 paid → 17000), the advance itself on credited_advance_cents.
    //   credited_cents === credited_paid_cents + credited_gifted_cents + credited_advance_cents
    //     + credited_trial_advance_cents
    // A subscription trial's credit (trial_seed + subscription_trial) is an ADVANCE on
    // the subscription, never a gift, repaid or not: credited_trial_advance_cents.
    // An off-platform payment (a staff grant marked as paid, lib/off-platform-payments)
    // is paid money: here and in cash_paid_cents, out of credited_gifted_cents.
    credited_paid_cents: addCents(
      subCents(
        subCents(funds.paidTopupsCents, funds.advanceRepaidCents),
        funds.trialRepaidCents
      ),
      funds.offPlatformPaidCents
    ),
    // Paid money that repaid a free trial (the trial-end subscription charge) and so
    // added NO credit. Additive; credited_paid_cents already excludes it.
    credited_trial_repaid_cents: funds.trialRepaidCents,
    // Every payment the org made us, NET of refunds and lost disputes, whatever it
    // repaid (trial, onboarding advance) or credited: the CASH figure ("invested").
    // Unlike credited_paid_cents it is never reduced by a repayment.
    cash_paid_cents: addCents(funds.paidTopupsCents, funds.offPlatformPaidCents),
    credited_gifted_cents: funds.giftedCreditsCents,
    credited_advance_cents: funds.advanceCents,
    credited_trial_advance_cents: funds.trialAdvanceCents,
    usage_cents: funds.usageCents,
    // Credit staff took OFF this org's balance (POST /v1/credits/debit), its own
    // line, never folded into usage_cents. Invariant:
    //   balance_cents === credited_cents − usage_cents − debited_cents
    debited_cents: funds.debitedCents,
    // Subscription credit that expired unspent at a renewal, its own line.
    //   balance_cents === credited_cents − usage_cents − debited_cents − expired_cents
    expired_cents: funds.expiredCents,
    balance_cents: funds.balanceCents,
    actual_balance_cents: funds.actualBalanceCents,
    // Free credit the org can still spend, ready-made so the dashboard decides a
    // "skip payment" option without doing money arithmetic in the browser.
    // Byte-unchanged by the trial re-base: a trialing org still runs on its trial
    // credit without paying first, so the trial advance counts here.
    free_credit_spendable_cents: spendableFreeCreditCents(
      addCents(funds.giftedCreditsCents, funds.trialAdvanceCents),
      funds.balanceCents
    ),
    // Per-org platform-usage discount percentage (0–100), or null when none. This
    // is EXPOSED for the customer dashboard banner only — it does NOT affect the
    // balance figures above. The discount is applied ONCE, at cost-write time, in
    // runs-service, so usage_cents (and thus balance_cents/actual_balance_cents) is
    // already net. Billing never re-applies it. See CLAUDE.md "Usage discount".
    usage_discount_pct: funds.discountPct,
    // Where the org stands on its free-credit offer, ready-made for the payment wall
    // ("$30 is already yours, $70 more once you've paid $100"). See
    // lib/free-credit-offer. `match_100` = "We match your first $100".
    free_credit_offer: freeCredit.offer,
    free_credit_entitlement_cents: freeCredit.entitlementCents,
    free_credit_received_cents: freeCredit.receivedCents,
    free_credit_pending_cents: freeCredit.pendingCents,
    free_credit_paid_trigger_cents: freeCredit.paidTriggerCents,
    free_credit_remaining_to_pay_cents: freeCredit.remainingToPayCents,
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
    // POSTPAID (owner 2026-10-21): no auto top-up, no "Add credit". Its credit line
    // (how far below $0 it may go before the card is charged), the step it is
    // charged by, and what it owes right now (the whole amount POST
    // /v1/accounts/pay_balance takes). null when not postpaid; the line is null
    // when no chargeable card can carry it.
    credit_line_cents: postpaidLine ? Math.abs(postpaidLine.thresholdCents) : null,
    credit_line_step_cents: postpaidLine ? postpaidLine.amountCents : null,
    // Did the card hold the first step (lib/postpaid-card-check)? 'required' | 'passed'
    // | 'refused' | 'grandfathered'; the bank's sentence when it refused.
    postpaid_card_check: account.postpaidCardCheck,
    postpaid_card_check_message: account.postpaidCardCheckMessage,
    amount_owed_cents:
      paymentMode === "postpaid"
        ? cmpCents(funds.actualBalanceCents, "0") < 0
          ? subCents("0", funds.actualBalanceCents)
          : "0.0000000000"
        : null,
    has_auto_topup:
      paymentMode === "prepaid" &&
      autoTopupArmed(account) &&
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

    const account = await findOrCreateAccount(orgId, userId);

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

// POST /v1/accounts/card_setup — what the BROWSER needs to render this org's
// card form, and nothing more.
//
// stripe-service resolves which acquirer holds the org's cards and DESCRIBES the
// mechanism rather than performing it, because the acquirers genuinely differ:
// one hosts a page we redirect to, the other saves a card only through a field
// the page mounts itself. This repo passes the descriptor through without
// interpreting it and without naming a vendor — the caller switches on `mode`,
// a UI concern it owns anyway.
//
// No credential reaches the browser: the only thing handed over is a per-order
// PUBLIC token scoped to this one setup attempt, and the card itself is typed
// inside an iframe the acquirer hosts, so the number never touches the calling
// page or this service. Nothing is added here, so nothing can be leaked here.
//
// `POST /v1/portal-sessions` serves the SAME descriptor under its historical
// name; both call one function, so the two can never answer differently.
router.post("/v1/accounts/card_setup", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;

    const parsed = CardSetupRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { return_url, currency, ui_mode } = parsed.data;

    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    if (!account) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }

    // Same rule as POST /v1/portal-sessions: an outstanding balance is
    // collected when the customer opens a card session, and the outcome never
    // gates it. The two routes serve one descriptor, so they must behave
    // identically or the behaviour is one URL away from diverging.
    // Its outcome is reported beside the descriptor, same fields as there.
    const settlement = await settleOutstandingBeforeCardChange(orgId);

    // Same as POST /v1/portal-sessions: an org with a billing row but no Stripe
    // customer (it started anonymous) gets one here, before stripe-service 409s.
    await ensureOrgStripeCustomer({
      "x-org-id": orgId,
      "x-user-id": req.headers["x-user-id"] as string,
      ...forwardWorkflowHeaders(getWorkflowHeaders(req)),
    });

    const setup = await getCardSetup(
      orgId,
      return_url,
      undefined,
      currency,
      ui_mode,
      req.headers["x-user-id"] as string
    );
    res.json({ ...setup, ...settlementWireFields(settlement) });
  } catch (err) {
    const message = errorReason(err);
    console.error("[billing-service] card setup failed:", message);
    res.status(502).json({ error: "Failed to start card setup" });
  }
});

// GET /v1/accounts/saved_payment_method — has this org given us a card we can
// charge later with nobody present?
//
// THREE answers, and they stay apart all the way to the wire:
//   200 {saved:true, method}  — there is one;
//   200 {saved:false, reason} — the acquirer answered and there is none;
//   502                        — we could not ask at all.
//
// Collapsing the last two is the whole hazard: read as "no card" it tells a
// customer to re-enter one we already hold; read as "card" it arms a recurring
// charge off a timeout. stripe-service keeps them apart deliberately and this
// route does not undo that.
router.get("/v1/accounts/saved_payment_method", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;

    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    if (!account) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }

    let answer;
    let facts;
    try {
      answer = await getSavedPaymentMethod(orgId);
      facts = await cardFactsFrom(orgId, answer);
    } catch (err) {
      const message = errorReason(err);
      console.error("[billing-service] saved payment method read failed:", message);
      res.status(502).json({ error: "Could not confirm whether a card is saved" });
      return;
    }

    // Additive: the card's prepaid + country facts and whether this org may be
    // POSTPAID with it (lib/card-facts), beside stripe-service's answer verbatim.
    res.json({ ...answer, ...cardFactsWire(facts) });
  } catch (err) {
    console.error("[billing-service] Error reading saved payment method:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /v1/accounts/saved_payment_method — stop holding this org's card.
//
// The inverse of the GET above, and the one self-serve path a customer has for
// it: the acquirer's own card-management screen is pinned shut on purpose.
//
// TWO actions in one order only this service can put them in. What is owed is
// collected FIRST, on the card that is about to go, under the SAME rule the
// card-change path uses (lib/card-change-settlement) — including its conclusion
// that the collection never gates what the customer came to do. Then the card
// goes, whatever that collection did.
//
// REFUSED FOR NOBODY. No balance, no debt state, no card state and no failed
// charge blocks it. A gate here would trap the one customer it exists to
// protect us from, which is exactly the dead end #461 removed from the card
// page. An org with no card is not an error either.
//
// Nothing is forgiven: no balance is erased or marked settled, and the debt
// stays owned by the month-end sweep, the campaign reload, dunning and the
// uncollectable-debt flag. A customer who comes back and adds a card is
// collected from as normal.
//
// 502 when the removal itself could not be performed — a caller that cannot
// tell whether the card is gone must be told so rather than handed a silent
// success.
router.delete("/v1/accounts/saved_payment_method", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;

    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    if (!account) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }

    let outcome;
    try {
      outcome = await removeCardForOrg(orgId);
    } catch (err) {
      const message = errorReason(err);
      console.error("[billing-service] card removal failed:", message);
      res.status(502).json({ error: "Could not remove the saved card" });
      return;
    }

    if (outcome.detached.length > 0) {
      notifyOwnerBillingEvent({
        orgId,
        emoji: "💳",
        text:
          "Card removed" +
          (outcome.autoTopupDisarmed ? ", automatic reload turned off" : "") +
          (outcome.settlement.chargedCents > 0 ? ` (${usd(outcome.settlement.chargedCents)} owed was collected first)` : ""),
      });
    }

    res.json({
      object: "saved_payment_method_removed",
      org_id: orgId,
      removed: outcome.detached.length,
      already_removed: outcome.alreadyDetached.length,
      auto_topup_disarmed: outcome.autoTopupDisarmed,
      ...settlementWireFields(outcome.settlement),
    });
  } catch (err) {
    console.error("[billing-service] Error removing saved payment method:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** Owner alert for a real auto top-up change (a re-save of the same values is not one). */
function notifyAutoTopupChange(
  orgId: string,
  before: { topupAmountCents: number | null; topupThresholdCents: number | null },
  amount: number,
  threshold: number
): void {
  const now = `${usd(amount)} when the balance falls below ${usd(threshold)}`;
  if (before.topupAmountCents == null) {
    notifyOwnerBillingEvent({ orgId, emoji: "⚙️", text: `Automatic reload turned ON: ${now}` });
    return;
  }
  if (before.topupAmountCents === amount && before.topupThresholdCents === threshold) return;
  const was = `${usd(before.topupAmountCents)} below ${usd(before.topupThresholdCents ?? 0)}`;
  notifyOwnerBillingEvent({
    orgId,
    emoji: "⚙️",
    text: `Automatic reload changed: ${was} → ${usd(amount)} below ${usd(threshold)}`,
  });
}

const POSTPAID_NO_AUTO_TOPUP = {
  error:
    "This account pays after use: it is charged as it spends ($50, then $200, then $500 steps, and at month end), so it has no automatic top-up.",
  code: "postpaid_no_auto_topup",
} as const;

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

    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    if (!account) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }

    // A SUBSCRIPTION org is never reloaded (owner rule: when credit runs out,
    // sending stops). Its money is the monthly invoice — lib/subscription.
    if (account.paymentMode === "subscription") {
      res.status(409).json({
        error: "This organization pays by subscription; automatic top-up is not available.",
        code: "subscription_mode",
      });
      return;
    }

    // "We match your first $100" orgs reload at least $100, and never let the
    // threshold sit below $5 (lib/free-credit-offer). Legacy orgs: unchanged.
    // A POSTPAID org has NO auto top-up (owner 2026-10-21: « l'autotopup n'a aucun
    // sens en post paid »): it is charged at the credit-line steps and at month end.
    if (account.paymentMode === "postpaid") {
      res.status(409).json(POSTPAID_NO_AUTO_TOPUP);
      return;
    }
    const { topup_amount_cents, topup_threshold_cents } = parsed.data;
    try {
      assertAutoTopupMinimums(
        topupMinimumsFor(account),
        topup_amount_cents,
        topup_threshold_cents
      );
    } catch (err) {
      if (err instanceof TopupBelowMinimumError) {
        res.status(400).json({
          error: err.message,
          code: err.code,
          minimum_cents: err.minimumCents,
        });
        return;
      }
      throw err;
    }

    // Arming automatic top-up commits us to charging this org with nobody
    // present, so it is gated on a card we KNOW is there.
    //
    // Which gate applies is decided by which acquirer holds the org's cards, and
    // stripe-service states that on the saved-method answer. The Stripe-shape
    // checks below (a card OR link payment method, plus the issuing-country
    // blocklist) answer correctly only for the acquirer they were written
    // against; every other acquirer is asked its OWN question instead. Nothing
    // here branches on a vendor's behaviour — only on "is this the acquirer the
    // legacy gate was written for", which is the carve-out that keeps the whole
    // existing fleet behaving exactly as it does today.
    //
    // A read that FAILS refuses (502). It is not a fourth answer we may treat as
    // a yes, and every other stripe-service call in this handler already fails
    // the same way, so an org on the original acquirer sees no new outcome
    // whenever stripe-service answers at all.
    let acquirer: string;
    try {
      acquirer = (await getSavedPaymentMethod(orgId)).acquirer;
    } catch (err) {
      console.error("[billing-service] Failed to resolve saved payment method:", err);
      res.status(502).json({ error: "Failed to query payment method status" });
      return;
    }

    if (acquirer !== LEGACY_PM_GATE_ACQUIRER) {
      // Ask the acquirer whether recurring charges may be armed. A refusal is a
      // 400 (add a card first); anything we could not ask is a 502 — an unknown
      // answer is not a yes. Arming without a confirmed card produces an org
      // that pays once and then fails its first reload with nothing reporting
      // why, which is the failure this gate exists to prevent.
      let authorization;
      try {
        authorization = await authorizeRecurringCharges(orgId);
      } catch (err) {
        console.error("[billing-service] Recurring-charge authorization failed:", err);
        res.status(502).json({ error: "Failed to query payment method status" });
        return;
      }
      if (!authorization.authorized) {
        res.status(400).json({
          error: "Payment method required. Add a card before enabling auto top-up.",
        });
        return;
      }
    } else {
      let hasCardPm: boolean;
      let cardCountry: string | null;
      try {
        // No customer → no saved card, by construction. That is a definite "no
        // payment method", so it must reach the 400 below, not the 502 an
        // unreadable stripe-service deserves. An unreachable stripe-service
        // still throws here and still 502s.
        const customer = await getCustomerByOrgOrNull(identity);
        [hasCardPm, cardCountry] = customer
          ? await Promise.all([
              hasAttachedCardPm(identity, customer.id),
              getOrgCardCountry(identity, customer.id),
            ])
          : [false, null];
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
    notifyAutoTopupChange(orgId, account, topup_amount_cents, topup_threshold_cents);

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

    // An org opened through the API pays PREPAID with a MANDATORY auto top-up
    // (owner 2026-10-12: « Autotopup is mandatory for prepaid because otherwise
    // their service would stop »). Its amounts can change (PATCH), not switch off.
    // Same for every org created under the at-cost offer (owner 2026-10-29: « comme via API »).
    if (
      (account.freeCreditOffer === AGENT_API_FREE_CREDIT_OFFER ||
        account.freeCreditOffer === AT_COST_FREE_CREDIT_OFFER) &&
      account.paymentMode === "prepaid"
    ) {
      res.status(409).json({
        error: "Automatic top-up is required for this prepaid organization; change its amounts instead.",
        code: "auto_topup_required",
      });
      return;
    }

    // A POSTPAID org has no auto top-up to switch off: it is charged as it spends.
    // Its brakes are the monthly limit, removing the card, or switching to prepaid.
    if (account.paymentMode === "postpaid") {
      res.status(409).json(POSTPAID_NO_AUTO_TOPUP);
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
    if (account.topupAmountCents != null) {
      notifyOwnerBillingEvent({ orgId, emoji: "⚙️", text: "Automatic reload turned OFF" });
    }

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

// POSTPAID: pay the WHOLE amount owed now, on the saved card (lib/pay-balance).
// The one money action a postpaid client has (owner 2026-10-21).
router.post("/v1/accounts/pay_balance", requireOrgHeaders, async (req, res) => {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const runId = req.headers["x-run-id"] as string;
    const wfHeaders = forwardWorkflowHeaders(getWorkflowHeaders(req));
    const identity = buildIdentity(orgId, userId, runId, wfHeaders);

    const [account] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId)).limit(1);
    if (!account) {
      res.status(404).json({ error: "Billing account not found" });
      return;
    }

    let charged;
    try {
      charged = await payOutstandingBalance(orgId, account.paymentMode);
    } catch (err) {
      if (err instanceof PayBalanceRefused) {
        res.status(409).json({ error: err.message, code: err.code, owed_cents: err.owedCents });
        return;
      }
      if (err instanceof OnDemandChargeError) {
        const status =
          err.code === "charge_declined" ? 402 : err.code === "charge_backoff" ? 429 : err.code === "upstream_error" ? 502 : 409;
        console.error(`[billing-service] pay_balance for org ${orgId} failed: [${err.code}] ${err.message}`);
        res.status(status).json({ error: err.message, code: err.code, owed_cents: err.amountCents });
        return;
      }
      throw err;
    }

    let funds;
    try {
      funds = await composeAccountFunds(orgId, identity);
    } catch (err) {
      console.error("[billing-service] Failed to compose account funds:", err);
      res.status(502).json({ error: "Failed to compose account funds" });
      return;
    }
    res.json({ charged_cents: charged.chargedCents, account: buildAccountResponse(account, funds) });
  } catch (err) {
    console.error("[billing-service] Error paying the balance:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
