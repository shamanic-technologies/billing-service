import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { computeBalance } from "./balance.js";
import { isCardUnusableFor } from "./card-usability.js";
import { asFreeCreditOffer } from "./free-credit-offer.js";
import { asPaymentMode } from "./payment-mode-types.js";
import {
  authorizeRecurringCharges,
  getSavedPaymentMethod,
  LEGACY_PM_GATE_ACQUIRER,
} from "./stripe-service-client.js";

/**
 * Where a prepaid org with MANDATORY auto top-up stands (the one-step prepaid
 * checkout, POST /v1/accounts/prepaid_checkout). The caller (an agent, through the
 * API) reads this after the payment page: the money lands from the payment, the card
 * from the same payment, and the auto top-up can fire only when that card can be
 * charged with nobody present.
 *
 * A card that cannot be recharged off-session is NOT refused: the payment already
 * happened on a hosted page, and the org keeps every cent it paid. It is FLAGGED
 * here (`state: "card_not_reloadable"` + a named reason), so the caller tells its
 * human to add another card instead of the org silently stopping when the credit
 * runs out.
 *
 *   awaiting_payment    nothing paid and no card saved yet
 *   active              prepaid, auto top-up armed, the saved card can be reloaded
 *   card_not_reloadable paid (or card saved) but the card cannot be charged
 *                       off-session; the credit is spendable, no reload will fire
 *   auto_topup_off      prepaid with no auto top-up configured
 *   not_prepaid         the org pays postpaid or by subscription
 */
export type PrepaidState =
  | "awaiting_payment"
  | "active"
  | "card_not_reloadable"
  | "auto_topup_off"
  | "not_prepaid";

export type CardNotReloadableReason =
  /** Paid, but no reusable card was saved. */
  | "no_saved_card"
  /** The card's issuing country cannot be charged off-session (e.g. India). */
  | "card_issuing_country_unsupported"
  /** A prepaid card: it passes a first payment, then declines unattended reloads. */
  | "prepaid_card"
  /** The acquirer holding the card refuses recurring charges on it. */
  | "recurring_charge_not_authorized"
  /** The issuer refused the card permanently (lost, stolen, closed). */
  | "card_unusable";

export interface PrepaidStatus {
  org_id: string;
  state: PrepaidState;
  payment_mode: string;
  free_credit_offer: string;
  paid_cents: string;
  balance_cents: string;
  auto_topup: { enabled: boolean; amount_cents: number | null; threshold_cents: number | null };
  card: { saved: boolean; reloadable: boolean; not_reloadable_reason: CardNotReloadableReason | null };
}

async function cardVerdict(
  orgId: string,
  snapshot: Awaited<ReturnType<typeof computeBalance>>
): Promise<{ saved: boolean; reason: CardNotReloadableReason | null }> {
  const saved = await getSavedPaymentMethod(orgId);
  if (!saved.saved) return { saved: false, reason: "no_saved_card" };
  if (saved.method?.prepaid === true) return { saved: true, reason: "prepaid_card" };
  if (saved.acquirer === LEGACY_PM_GATE_ACQUIRER) {
    if (!snapshot.hasCardPm) return { saved: true, reason: "no_saved_card" };
    if (!snapshot.autoReloadSupported) {
      return { saved: true, reason: "card_issuing_country_unsupported" };
    }
  } else if (!(await authorizeRecurringCharges(orgId)).authorized) {
    return { saved: true, reason: "recurring_charge_not_authorized" };
  }
  if (await isCardUnusableFor(orgId, snapshot.creditedCents)) {
    return { saved: true, reason: "card_unusable" };
  }
  return { saved: true, reason: null };
}

/** The org's prepaid status, or null when it has no billing account. Throws when stripe-service / runs-service cannot be read. */
export async function resolvePrepaidStatus(orgId: string): Promise<PrepaidStatus | null> {
  const [account] = await db
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  if (!account) return null;

  const snapshot = await computeBalance(orgId);
  const card = await cardVerdict(orgId, snapshot);
  const paymentMode = asPaymentMode(account.paymentMode);
  const autoTopupEnabled = account.topupAmountCents != null && account.topupThresholdCents != null;
  const paid = Number(snapshot.paidTopupsCents) > 0;

  let state: PrepaidState;
  if (paymentMode !== "prepaid") state = "not_prepaid";
  else if (!autoTopupEnabled) state = "auto_topup_off";
  else if (!paid && !card.saved) state = "awaiting_payment";
  else if (card.reason) state = "card_not_reloadable";
  else state = "active";

  return {
    org_id: orgId,
    state,
    payment_mode: paymentMode,
    free_credit_offer: asFreeCreditOffer(account.freeCreditOffer),
    paid_cents: snapshot.paidTopupsCents,
    balance_cents: snapshot.balanceCents,
    auto_topup: {
      enabled: autoTopupEnabled,
      amount_cents: account.topupAmountCents,
      threshold_cents: account.topupThresholdCents,
    },
    card: { saved: card.saved, reloadable: card.reason === null, not_reloadable_reason: card.reason },
  };
}
