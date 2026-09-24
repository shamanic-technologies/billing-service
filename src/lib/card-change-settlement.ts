/**
 * Collect what the customer owes when they open a card-management session — and
 * hand the session over whatever happens to that collection.
 *
 * A customer who owes us money on the postpaid credit line should pay it at the
 * moment they touch the card that owes it: that is what Google Ads, Meta and AWS
 * do, it is the common case, and for a healthy card it works — the debt clears
 * right there. So the settle attempt fires at click time, on the card on file,
 * for exactly what is owed.
 *
 * What it must NEVER do is gate the session on its own outcome. That was the
 * original rule (PR #437) and it produced a dead end for exactly the person the
 * card page exists for: to replace the card you must first pay, to pay you need
 * a working card, and the only card we will charge is the one that does not
 * work. Observed in prod 2026-09-17 — a debtor on a declining Macedonian Visa
 * clicked twice, was charged nothing and refused twice, and could not reach the
 * screen that would have fixed it. Refusing the session does not protect the
 * debt; it guarantees we can never collect it.
 *
 * The rule, in full — every branch opens the session:
 *
 *   balance >= 0            → nothing owed, no charge attempted.
 *   negative, has a card    → charge EXACTLY the outstanding amount. Charged,
 *                             declined, backed off, timed out, stripe-service
 *                             unreachable: the session is handed over either way
 *                             and a failure is LOUD in the logs.
 *   negative, NO card       → nothing to charge. Adding a card IS the recovery,
 *                             and the org is separately flagged as an
 *                             uncollectable debt (see lib/unpaid-debt).
 *   negative, blocked card  → an issuing country that cannot be charged
 *                             off_session (India / RBI) cannot be settled here
 *                             at all.
 *   negative, dead card     → a card the issuer called lost / stolen / closed
 *                             may NEVER be re-presented (see lib/card-usability).
 *                             No charge is attempted at all.
 *   negative, below $0.50   → the acquirer rejects a smaller charge outright.
 *
 * Collection is not abandoned by any of this: what is owed stays owed and stays
 * owned by the existing sweeps — the month-end settle-to-zero, the campaign
 * reload when the credit line is crossed, and dunning.
 *
 * The amount is `computeSettleCharge` — the SAME arithmetic the month-end sweep
 * bills, deliberately imported rather than restated, so the two surfaces can
 * never disagree about what settling to zero means.
 */

import crypto from "crypto";
import { computeBalance, type BalanceSnapshot } from "./balance.js";
import { isCardUnusableFor } from "./card-usability.js";
import { cmpCents } from "./cents.js";
import { computeSettleCharge, STRIPE_MIN_CHARGE_CENTS } from "./month-end-sweep.js";
import { coalesceReload } from "./reload-coalescer.js";
import { reloadOffSession } from "./reload.js";

/** A hung stripe-service call must not hold the customer's browser forever. */
const SETTLE_TIMEOUT_MS = 30_000;

/** Why nothing was collected. Diagnostic only — never gates the session. */
export type SettlementSkipReason =
  | "nothing_owed"
  | "no_card"
  | "card_blocked_off_session"
  | "card_unusable"
  | "below_minimum"
  /** The card declined, or stripe-service could not take the money. */
  | "charge_failed"
  /** A recent decline put this org in the reload backoff — no charge attempted. */
  | "charge_backoff"
  /** The balance itself could not be read, so nothing could be attempted. */
  | "balance_unavailable";

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

/**
 * What happened to the settle, as the CALLER must tell the customer — one of:
 *
 *   charged       → the outstanding balance was taken (`chargedCents`).
 *   declined      → the acquirer answered and REFUSED the card; the balance is
 *                   still owed. `declineMessage` carries the acquirer's own
 *                   customer-readable sentence when it gave one.
 *   failed        → we could not get an answer (stripe-service error, timeout);
 *                   nothing is known to have been charged and the balance is
 *                   still owed. Deliberately NOT called a decline: telling a
 *                   customer their card was refused when it never reached their
 *                   bank sends them to replace a card that works.
 *   not_attempted → no charge was presented (`skipReason` says why: nothing
 *                   owed, no card, a blocked or dead card, below the minimum,
 *                   the reload backoff, an unreadable balance).
 *
 * Reported, never a veto: every value hands the session over.
 */
export type SettlementResult = "charged" | "declined" | "failed" | "not_attempted";

export interface SettlementOutcome {
  /** What the caller tells the customer. See `SettlementResult`. */
  result: SettlementResult;
  /**
   * The acquirer's customer-readable refusal sentence. Set only when
   * `result === "declined"` and the acquirer gave one; null otherwise. Never a
   * raw payload or a code.
   */
  declineMessage: string | null;
  /** Cents actually charged (0 when nothing was owed or nothing could be taken). */
  chargedCents: number;
  /** The balance read before the settle; null when it could not be read. */
  balanceCents: string | null;
  /** Why nothing was charged. Absent when the settle landed. */
  skipReason?: SettlementSkipReason;
  /** The snapshot the decision was made on — saves the caller a second read. */
  snapshot?: BalanceSnapshot;
}

/**
 * Collect any outstanding balance when a card-management session is opened.
 *
 * NEVER throws and never refuses: it always resolves, and the caller always
 * hands the session over. The returned outcome is for logging and tests.
 */
export async function settleOutstandingBeforeCardChange(
  orgId: string,
  now: Date = new Date()
): Promise<SettlementOutcome> {
  try {
    return await attemptSettle(orgId, now);
  } catch (err) {
    // The balance read, the usability read, or something else entirely failed.
    // The session still opens — the debt stays owed and stays owned by the
    // month-end sweep, the campaign reload and dunning.
    console.error(
      `[billing-service] card change: could not attempt a settle for org ${orgId} — ` +
        `opening the session anyway:`,
      err instanceof Error ? err.message : String(err)
    );
    return {
      result: "not_attempted",
      declineMessage: null,
      chargedCents: 0,
      balanceCents: null,
      skipReason: "balance_unavailable",
    };
  }
}

async function attemptSettle(orgId: string, now: Date): Promise<SettlementOutcome> {
  const snapshot = await computeBalance(orgId);
  const balanceCents = snapshot.balanceCents;
  const skip = (
    skipReason: SettlementSkipReason,
    result: SettlementResult = "not_attempted",
    declineMessage: string | null = null
  ): SettlementOutcome => ({
    result,
    declineMessage,
    chargedCents: 0,
    balanceCents,
    skipReason,
    snapshot,
  });

  if (cmpCents(balanceCents, "0") >= 0) return skip("nothing_owed");

  if (!snapshot.hasCardPm) {
    // Nothing to charge. Adding a card is this org's only way out of the debt,
    // and it is separately flagged as uncollectable.
    console.warn(
      `[billing-service] card change: org ${orgId} owes ${balanceCents} cents with ` +
        `no chargeable card — opening the session so a card can be added`
    );
    return skip("no_card");
  }

  if (!snapshot.autoReloadSupported) {
    // The saved card's issuing country cannot be charged off_session at all.
    console.warn(
      `[billing-service] card change: org ${orgId} owes ${balanceCents} cents on a ` +
        `card that cannot be charged off_session (country=${snapshot.cardCountry ?? "unknown"}) — ` +
        `opening the session`
    );
    return skip("card_blocked_off_session");
  }

  if (await isCardUnusableFor(orgId, snapshot.creditedCents)) {
    // The issuer called this card lost / stolen / closed. Card-network rules
    // forbid re-presenting it at any interval, and replacing it is exactly what
    // the customer is here to do.
    console.warn(
      `[billing-service] card change: org ${orgId} owes ${balanceCents} cents on a card ` +
        `the issuer judged permanently unusable — no charge attempted, opening the session`
    );
    return skip("card_unusable");
  }

  const chargeAmount = computeSettleCharge(balanceCents);
  if (chargeAmount <= 0) {
    // Below the acquirer's minimum charge — rolls into the month-end sweep like
    // any other sub-minimum deficit.
    console.log(
      `[billing-service] card change: org ${orgId} owes ${balanceCents} cents, below ` +
        `the ${STRIPE_MIN_CHARGE_CENTS}-cent minimum — opening the session`
    );
    return skip("below_minimum");
  }

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
      `[billing-service] card change: settle of ${chargeAmount} cents DECLINED for org ` +
        `${orgId} (owed ${balanceCents} cents) — opening the session anyway:`,
      err instanceof Error ? err.message : String(err)
    );
    // No acquirer answer reached us, so we cannot claim the CARD was refused —
    // and the thrown text is not customer-readable, so it is never surfaced.
    return skip("charge_failed", "failed");
  }

  if (outcome.status !== "succeeded") {
    const reason: SettlementSkipReason = outcome.backoffSkipped
      ? "charge_backoff"
      : "charge_failed";
    console.warn(
      `[billing-service] card change: settle of ${chargeAmount} cents did NOT land for org ` +
        `${orgId} (owed ${balanceCents} cents, ${reason}: ` +
        `${outcome.failure_reason ?? outcome.status}) — opening the session anyway`
    );
    if (reason === "charge_backoff") return skip(reason);
    // The acquirer answered and refused. Its own sentence is the only part of
    // the refusal the customer may see.
    const message = outcome.failure_message?.trim() || null;
    return skip(reason, "declined", message);
  }

  console.log(
    `[billing-service] card change: settled ${chargeAmount} cents for org ${orgId} ` +
      `before opening a card session`
  );
  return {
    result: "charged",
    declineMessage: null,
    chargedCents: chargeAmount,
    balanceCents,
    snapshot,
  };
}

/**
 * The settle outcome as it goes on the wire — ONE vocabulary for every route
 * that settles before touching a card (the card session, card removal), so the
 * dashboard reads one concept one way. `settled_cents` / `settle_skip_reason`
 * keep their original meaning; `settle_result` / `settle_decline_message` say
 * what to tell the customer.
 */
export function settlementWireFields(outcome: SettlementOutcome): {
  settle_result: SettlementResult;
  settled_cents: number;
  settle_skip_reason?: SettlementSkipReason;
  settle_decline_message: string | null;
} {
  return {
    settle_result: outcome.result,
    settled_cents: outcome.chargedCents,
    ...(outcome.skipReason ? { settle_skip_reason: outcome.skipReason } : {}),
    settle_decline_message: outcome.declineMessage,
  };
}
