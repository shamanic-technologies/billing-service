/**
 * Settle what the customer owes BEFORE handing them a card-management session.
 *
 * A customer who owes us money on the postpaid credit line must never be able to
 * leave us with the debt and no card to collect it. That is what Google Ads,
 * Meta and AWS all do: the outstanding balance is settled first, and only then
 * may the payment method be changed. stripe-service separately makes the
 * acquirer's card page replace-only, but the collection has to happen here —
 * this service is the one that knows what is owed.
 *
 * The rule, in full:
 *
 *   balance >= 0            → open the session, exactly as before.
 *   negative, has a card    → charge EXACTLY the outstanding amount first.
 *                             Success opens the session; failure REFUSES it and
 *                             states what is owed.
 *   negative, NO card       → open the session. There is nothing to charge, and
 *                             adding a card IS the recovery — refusing here
 *                             would trap the org in a debt it can never pay.
 *                             That org is separately flagged as an uncollectable
 *                             debt (see lib/unpaid-debt).
 *   negative, blocked card  → open the session. An issuing country that cannot
 *                             be charged off_session (India / RBI) cannot be
 *                             settled by this path at all, so blocking the one
 *                             screen where they could act is pure harm.
 *   negative, below $0.50   → open the session. Stripe rejects a smaller charge
 *                             outright; the remainder rolls into the month-end
 *                             sweep like any other sub-minimum deficit.
 *
 * The amount is `computeSettleCharge` — the SAME arithmetic the month-end sweep
 * bills, deliberately imported rather than restated, so the two surfaces can
 * never disagree about what settling to zero means.
 *
 * Fail-loud: a charge-path error refuses the session. Nothing here falls back to
 * opening it anyway.
 */

import crypto from "crypto";
import { computeBalance, type BalanceSnapshot } from "./balance.js";
import { cmpCents } from "./cents.js";
import { computeSettleCharge, STRIPE_MIN_CHARGE_CENTS } from "./month-end-sweep.js";
import { coalesceReload } from "./reload-coalescer.js";
import { reloadOffSession } from "./reload.js";

/** A hung stripe-service call must not hold the customer's browser forever. */
const SETTLE_TIMEOUT_MS = 30_000;

/** Why a card-change session was refused — distinguishable on the wire. */
export type SettlementFailureReason =
  /** The card declined, or stripe-service could not take the money. */
  | "charge_failed"
  /** A recent decline put this org in the reload backoff — no charge attempted. */
  | "charge_backoff";

/**
 * Thrown when an outstanding balance could NOT be settled, so the card-change
 * session must not be handed over. Carries what the customer owes so the caller
 * can say it — the dashboard distinguishes this from every other failure.
 */
export class OutstandingBalanceError extends Error {
  readonly owedCents: string;
  readonly balanceCents: string;
  readonly reason: SettlementFailureReason;

  constructor(params: {
    owedCents: string;
    balanceCents: string;
    reason: SettlementFailureReason;
    message: string;
  }) {
    super(params.message);
    this.name = "OutstandingBalanceError";
    this.owedCents = params.owedCents;
    this.balanceCents = params.balanceCents;
    this.reason = params.reason;
  }
}

/** "YYYY-MM-DD" (UTC) — the idempotency scope for one day's settle attempts. */
export function dayBucket(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Idempotency key scoped to (org, UTC day, charge amount).
 *
 * The AMOUNT is in the key for the reason the month-end sweep documents at
 * length: stripe-service derives its acquirer keys from this one, and an
 * acquirer rejects a replayed key whose parameters changed — so an
 * amount-independent key makes a second, DIFFERENT settle impossible and
 * replays a stale charge. The DAY is in it so a retry of the same settle within
 * the day collapses onto one charge (the customer clicking twice, a browser
 * retry) while a genuine settle of the same amount next week still goes through.
 */
export function cardChangeSettleIdempotencyKey(
  orgId: string,
  bucket: string,
  chargeAmountCents: number
): string {
  return crypto
    .createHash("sha256")
    .update(`card-change-settle:${orgId}:${bucket}:${chargeAmountCents}`)
    .digest("hex")
    .slice(0, 32);
}

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`card-change settle timeout after ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export interface SettlementOutcome {
  /** Cents actually charged (0 when nothing was owed or nothing could be taken). */
  chargedCents: number;
  /** The balance read before the settle. */
  balanceCents: string;
  /** The snapshot the decision was made on — saves the caller a second read. */
  snapshot: BalanceSnapshot;
}

/**
 * Collect any outstanding balance before a card-management session is opened.
 *
 * Resolves when the session may be handed over (nothing owed, settled, or
 * nothing collectable). Throws `OutstandingBalanceError` when the org owes money
 * we could have taken and the charge did not land — the session must NOT be
 * opened in that case.
 */
export async function settleOutstandingBeforeCardChange(
  orgId: string,
  now: Date = new Date()
): Promise<SettlementOutcome> {
  const snapshot = await computeBalance(orgId);
  const balanceCents = snapshot.balanceCents;
  const nothingToDo: SettlementOutcome = { chargedCents: 0, balanceCents, snapshot };

  if (cmpCents(balanceCents, "0") >= 0) return nothingToDo;

  if (!snapshot.hasCardPm) {
    // Nothing to charge. Adding a card is this org's only way out of the debt,
    // and it is separately flagged as uncollectable, so the session opens.
    console.warn(
      `[billing-service] card change: org ${orgId} owes ${balanceCents} cents with ` +
        `no chargeable card — opening the session so a card can be added`
    );
    return nothingToDo;
  }

  if (!snapshot.autoReloadSupported) {
    // The saved card's issuing country cannot be charged off_session at all, so
    // there is no settle to perform here — blocking would be pure harm.
    console.warn(
      `[billing-service] card change: org ${orgId} owes ${balanceCents} cents on a ` +
        `card that cannot be charged off_session (country=${snapshot.cardCountry ?? "unknown"}) — ` +
        `opening the session`
    );
    return nothingToDo;
  }

  const chargeAmount = computeSettleCharge(balanceCents);
  if (chargeAmount <= 0) {
    // Below Stripe's minimum charge — uncollectable this instant, rolls into the
    // month-end sweep like any other sub-minimum deficit.
    console.log(
      `[billing-service] card change: org ${orgId} owes ${balanceCents} cents, below ` +
        `the ${STRIPE_MIN_CHARGE_CENTS}-cent minimum — opening the session`
    );
    return nothingToDo;
  }

  const owedCents = String(chargeAmount);
  let outcome;
  try {
    outcome = await coalesceReload(orgId, () =>
      withTimeout(
        SETTLE_TIMEOUT_MS,
        reloadOffSession(
          orgId,
          chargeAmount,
          cardChangeSettleIdempotencyKey(orgId, dayBucket(now), chargeAmount),
          { reason: "card_change_settlement" }
        )
      )
    );
  } catch (err) {
    // A declined off_session charge arrives as a THROW (stripe-service answers
    // non-2xx), which is the ordinary case here, not an exotic one.
    console.warn(
      `[billing-service] card change: settle of ${chargeAmount} cents failed for org ` +
        `${orgId}:`,
      err instanceof Error ? err.message : String(err)
    );
    throw new OutstandingBalanceError({
      owedCents,
      balanceCents,
      reason: "charge_failed",
      message: `Outstanding balance of ${owedCents} cents could not be settled`,
    });
  }

  if (outcome.status !== "succeeded") {
    throw new OutstandingBalanceError({
      owedCents,
      balanceCents,
      reason: outcome.backoffSkipped ? "charge_backoff" : "charge_failed",
      message:
        `Outstanding balance of ${owedCents} cents could not be settled: ` +
        `${outcome.failure_reason ?? outcome.status}`,
    });
  }

  console.log(
    `[billing-service] card change: settled ${chargeAmount} cents for org ${orgId} ` +
      `before opening a card session`
  );
  return { chargedCents: chargeAmount, balanceCents, snapshot };
}
