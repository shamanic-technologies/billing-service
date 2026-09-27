/**
 * PREPAID or POSTPAID — how an org pays. The CUSTOMER's explicit choice (made in
 * onboarding, switchable from the Billing page, settable by staff), never inferred
 * from whether a card is on file.
 *
 *  - POSTPAID is exactly the behaviour every org had before this existed: a credit
 *    line the balance may run below zero into (lib/topup-tier), a card required to
 *    collect on it, and "no chargeable card" is a `charge_blocked` verdict that
 *    stops the org's campaigns (lib/payment-outlook → campaign-service).
 *  - PREPAID spends only money already paid in. Floor ZERO, no card required.
 *    Having no card, or auto top-up off, never produces `charge_blocked`: spend
 *    simply stops at zero, through the existing affordability check and the
 *    ordinary out-of-credit dunning. Auto top-up stays available and optional,
 *    and is switched ON when an org becomes prepaid (the customer can turn it off).
 *
 * Every existing org is postpaid (migration 0050 defaults the column), so nothing
 * changes for anyone until someone chooses.
 *
 * SWITCHING:
 *  - postpaid → prepaid with a NEGATIVE balance: what is owed is collected FIRST,
 *    on the saved card, through the existing on-demand charge (owner decision:
 *    force the payment). A switch that cannot settle the debt does NOT happen and
 *    the refusal names why. Otherwise prepaid would erase a credit line the org
 *    has already drawn on.
 *  - prepaid → postpaid: postpaid rules apply from then on (so a card becomes
 *    required). Nothing is charged by the switch itself.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { computeBalance } from "./balance.js";
import { cmpCents } from "./cents.js";
import { computeSettleCharge } from "./month-end-sweep.js";
import { chargeOrgOnDemand, OnDemandChargeError } from "./on-demand-charge.js";
import { tierFor } from "./topup-tier.js";
import { asPaymentMode, type PaymentMode } from "./payment-mode-types.js";

export { PAYMENT_MODES, isPaymentMode, asPaymentMode } from "./payment-mode-types.js";
export type { PaymentMode } from "./payment-mode-types.js";

/** Why a switch to prepaid did not happen. Stable codes a caller branches on. */
export type PaymentModeRefusalCode =
  /** The org owes money and holds no card we can charge for it. */
  | "outstanding_balance_no_card"
  /** The org owes money and the card was refused (or is in retry backoff). */
  | "outstanding_balance_charge_declined"
  /** The org owes less than the smallest amount a card can be charged. */
  | "outstanding_balance_below_minimum_charge";

export class PaymentModeSwitchRefused extends Error {
  readonly code: PaymentModeRefusalCode;
  readonly owedCents: string;
  constructor(code: PaymentModeRefusalCode, owedCents: string, message: string) {
    super(message);
    this.name = "PaymentModeSwitchRefused";
    this.code = code;
    this.owedCents = owedCents;
  }
}

/** No billing account for the org — nothing to read or switch. */
export class PaymentModeAccountNotFound extends Error {
  constructor(orgId: string) {
    super(`No billing account for org ${orgId}`);
    this.name = "PaymentModeAccountNotFound";
  }
}

export interface PaymentModeState {
  orgId: string;
  paymentMode: PaymentMode;
  /** Cents collected by THIS switch to settle what was owed ("0" when none). */
  settledCents: string;
  /** Whether auto top-up is configured on (the stored flag) after the call. */
  autoTopupEnabled: boolean;
}

/** The org's payment mode, or null when it has no billing account. */
export async function getPaymentMode(orgId: string): Promise<PaymentMode | null> {
  const [row] = await db
    .select({ paymentMode: billingAccounts.paymentMode })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  return row ? asPaymentMode(row.paymentMode) : null;
}

function owedFrom(balanceCents: string): string {
  return balanceCents.replace(/^-/, "");
}

/**
 * Collect everything a postpaid org owes before it may become prepaid. Resolves
 * with the cents collected; throws `PaymentModeSwitchRefused` when it cannot.
 * Upstream failures (stripe-service / runs-service unreachable) propagate.
 */
async function settleBeforePrepaid(orgId: string): Promise<string> {
  const snapshot = await computeBalance(orgId);
  if (cmpCents(snapshot.balanceCents, "0") >= 0) return "0";

  const owed = owedFrom(snapshot.balanceCents);
  const amount = computeSettleCharge(snapshot.balanceCents);
  if (amount === 0) {
    throw new PaymentModeSwitchRefused(
      "outstanding_balance_below_minimum_charge",
      owed,
      "This account owes less than the smallest amount a card can be charged. " +
        "Add credit to bring the balance to zero, then switch to prepaid."
    );
  }

  try {
    await chargeOrgOnDemand(orgId, amount);
  } catch (err) {
    if (err instanceof OnDemandChargeError) {
      if (
        err.code === "no_chargeable_payment_method" ||
        err.code === "card_not_chargeable_off_session"
      ) {
        throw new PaymentModeSwitchRefused(
          "outstanding_balance_no_card",
          owed,
          "This account has an outstanding balance and no card we can charge for it. " +
            "Pay what is owed (add a card or add credit), then switch to prepaid."
        );
      }
      if (err.code === "charge_declined" || err.code === "charge_backoff") {
        throw new PaymentModeSwitchRefused(
          "outstanding_balance_charge_declined",
          owed,
          "We could not charge your card for the outstanding balance, so the switch " +
            "to prepaid did not happen. Pay what is owed, then try again."
        );
      }
    }
    throw err;
  }
  return String(amount);
}

/**
 * Set an org's payment mode. Idempotent: asking for the mode it already has is a
 * no-op that charges nothing.
 */
export async function setPaymentMode(
  orgId: string,
  target: PaymentMode
): Promise<PaymentModeState> {
  const [account] = await db
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  if (!account) throw new PaymentModeAccountNotFound(orgId);

  const current = asPaymentMode(account.paymentMode);
  if (current === target) {
    return {
      orgId,
      paymentMode: current,
      settledCents: "0",
      autoTopupEnabled: account.topupAmountCents != null,
    };
  }

  let settledCents = "0";
  const patch: Partial<typeof billingAccounts.$inferInsert> = {
    paymentMode: target,
    updatedAt: new Date(),
  };

  if (target === "prepaid") {
    settledCents = await settleBeforePrepaid(orgId);
    // Auto top-up is ON by default for a prepaid org. The stored columns are only
    // the enabled flag (lib/topup-tier derives the effective amount), so an org
    // that already had it on keeps its row untouched; one that had it off gets the
    // flag set. Without a chargeable card the flag is inert until one is added —
    // no card is required for prepaid.
    if (account.topupAmountCents == null) {
      patch.topupAmountCents = tierFor("0").amountCents;
      patch.topupThresholdCents = 0;
    }
  }

  const [updated] = await db
    .update(billingAccounts)
    .set(patch)
    .where(eq(billingAccounts.orgId, orgId))
    .returning();

  console.log(
    `[billing-service] payment mode: org ${orgId} ${current} → ${target}` +
      (settledCents !== "0" ? ` (settled ${settledCents} cents first)` : "")
  );

  return {
    orgId,
    paymentMode: asPaymentMode(updated.paymentMode),
    settledCents,
    autoTopupEnabled: updated.topupAmountCents != null,
  };
}
