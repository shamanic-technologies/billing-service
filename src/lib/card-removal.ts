/**
 * Stop holding a customer's card, as an ordinary self-serve action.
 *
 * Removing a card is not one action, it is two, and only this service can put
 * them in the right order: somebody who owes money should pay it at the moment
 * they touch the card that owes it, and then the card has to go. stripe-service
 * owns the acquirer half and deliberately collects nothing — it has no idea
 * whether the org owes us money.
 *
 * ## The collection is the card-change rule, unchanged
 *
 * `settleOutstandingBeforeCardChange` is imported rather than restated. It is
 * already correct, already tested, and it already carries the conclusion this
 * path needs most: the collection NEVER gates what the customer came to do.
 * That rule was learned on the card-change path (PR #437 → #461), where
 * refusing the session trapped exactly the customer it existed for — their card
 * is dead, which is why the charge failed, which is why they are here.
 *
 * ## The removal happens whatever the collection did
 *
 * Charged, declined, skipped, backed off, stripe-service unreachable while
 * reading the balance: the detach is attempted either way and the failure is
 * loud in the logs. The owner's decision, in his words: we try to collect, and
 * if it fails, so be it, we let the person leave.
 *
 * ## Nothing is forgiven
 *
 * No balance is erased, adjusted or marked settled. What is owed stays owed and
 * stays owned by the existing sweeps — the month-end settle-to-zero, the
 * campaign reload, dunning — and by the uncollectable-debt flag. A customer who
 * comes back and adds a card is collected from as normal.
 *
 * ## The after-state is NOT run inline
 *
 * Losing the last chargeable card drops the org's postpaid credit-line floor to
 * "0", tells the customer, and surfaces it to staff among the unpaid debts. All
 * of that already exists and is driven by stripe-service's
 * `payment_method.detached` event, which fires for a detach WE initiate exactly
 * as for one the customer performs. Calling `flagUncollectableDebt` here would
 * mean one detach producing two notifications, so it is deliberately absent.
 *
 * ## Auto-topup is disarmed
 *
 * An org with no card cannot be reloaded, so a stored threshold is a
 * configuration that can never fire again. It is cleared with the same write
 * `DELETE /v1/accounts/auto_topup` performs — which is also what drops the org
 * out of the month-end sweep's candidate set.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import {
  settleOutstandingBeforeCardChange,
  type SettlementOutcome,
} from "./card-change-settlement.js";
import { removeSavedPaymentMethods } from "./stripe-service-client.js";

export interface CardRemovalOutcome {
  /** Ids the acquirer detached on this call. */
  detached: string[];
  /** Ids already gone when we asked — an org with no card is not an error. */
  alreadyDetached: string[];
  /** Whether a stored auto-topup configuration was cleared by this removal. */
  autoTopupDisarmed: boolean;
  /** What the collection attempt did. Diagnostic — it never gates the removal. */
  settlement: SettlementOutcome;
}

/**
 * Collect what is owed, then remove the card.
 *
 * THROWS only when the removal itself could not be performed (stripe-service
 * unreachable or erroring) — the caller answers that loudly, because a caller
 * that cannot tell whether the card is gone must retry rather than be told it
 * succeeded. A collection failure never throws: it is logged and the removal
 * proceeds.
 */
export async function removeCardForOrg(orgId: string): Promise<CardRemovalOutcome> {
  // Never throws, never refuses — see lib/card-change-settlement.
  const settlement = await settleOutstandingBeforeCardChange(orgId);

  if (settlement.chargedCents > 0) {
    console.log(
      `[billing-service] card removal: collected ${settlement.chargedCents} cents for org ` +
        `${orgId} before removing the card`
    );
  } else if (settlement.skipReason && settlement.skipReason !== "nothing_owed") {
    // Loud, and not a veto: the debt stays owed and stays owned by the sweeps.
    console.warn(
      `[billing-service] card removal: org ${orgId} is at a balance of ` +
        `${settlement.balanceCents ?? "unknown"} cents and nothing was collected ` +
        `(${settlement.skipReason}) — removing the card anyway; the debt is unchanged`
    );
  }

  const removal = await removeSavedPaymentMethods(orgId);

  // An org with no card is not an error, but there is also nothing left that an
  // automatic charge could ever reach, so the stored configuration goes.
  const [before] = await db
    .select({ amount: billingAccounts.topupAmountCents })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);

  await db
    .update(billingAccounts)
    .set({ topupAmountCents: null, topupThresholdCents: null, updatedAt: new Date() })
    .where(eq(billingAccounts.orgId, orgId));

  const autoTopupDisarmed = before?.amount != null;

  console.log(
    `[billing-service] card removal: org ${orgId} — detached ${removal.detached.length}, ` +
      `already gone ${removal.already_detached.length}, auto-topup ${
        autoTopupDisarmed ? "disarmed" : "was not armed"
      }`
  );

  return {
    detached: removal.detached,
    alreadyDetached: removal.already_detached,
    autoTopupDisarmed,
    settlement,
  };
}
