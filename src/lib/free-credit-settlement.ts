/**
 * One entry point for settling every free-credit promise an org holds.
 *
 * An org used to have exactly one outstanding promise (the welcome offer), so every
 * caller that held the org's paid-topups sum called `settleWelcomeCompletion`
 * directly. With referral promises an org can hold several at once, so callers settle
 * through here instead and the two legs stay in one place:
 *
 *   1. the WELCOME promise — lib/welcome-completion.ts, arithmetic unchanged; the
 *      promise row is materialised first so the offer is one of the listed promises
 *      and so a later referral bar stacks above it.
 *   2. every REFERRAL reward this org's payments have now earned for whoever
 *      referred it — lib/free-credit-promises.ts. Those land on the REFERRER's
 *      account, never on this org, so they are NOT in `grantedCents`.
 *
 * `paidTopupsCents` is the org's cumulative SUCCEEDED payments NET of refunds and
 * lost disputes — the figure the callers already computed. Every condition is derived
 * from that plus billing's own ledger, so a request can only make an already-earned
 * grant land sooner; nothing a caller asserts can conjure one, and the unconditional
 * sweep settles an org that never opens the app.
 *
 * Fails loud (a missing ledger key throws) and is idempotent under replay and
 * concurrency — see the two modules for the exactly-once guards.
 */

import { Decimal } from "decimal.js";
import {
  ensureWelcomePromise,
  settleReferralsEarnedBy,
  type ReferralSettleResult,
} from "./free-credit-promises.js";
import {
  settleWelcomeCompletion,
  type WelcomeCompletionOutcome,
} from "./welcome-completion.js";

export interface FreeCreditSettleResult {
  /** Everything granted to THIS org by this call (canonical cents string). */
  grantedCents: string;
  welcome: WelcomeCompletionOutcome;
  referrals: ReferralSettleResult;
}

export async function settleFreeCreditPromises(
  orgId: string,
  paidTopupsCents: string
): Promise<FreeCreditSettleResult> {
  await ensureWelcomePromise(orgId);

  const welcome = await settleWelcomeCompletion(orgId, paidTopupsCents);
  const referrals = await settleReferralsEarnedBy(orgId, paidTopupsCents);

  const grantedCents = new Decimal(welcome.amountCents).toFixed(10);

  return { grantedCents, welcome, referrals };
}

/**
 * The account read's settle, run only when the org's money received MOVED
 * (MON-DB-HOT-1112).
 *
 * `GET /v1/accounts` sits on every dashboard page and used to run the whole settle
 * (account read, promise upsert, discount read, ledger sums, referral scan) on every
 * call, before the rest of the page's reads: 1.0-1.3 s at 40 concurrent reads on a
 * busy database. The settle's outcome is decided by the org's paid sum plus
 * billing's own ledger, and the ledger only changes through a settle (or a staff
 * act the hourly sweep re-examines). So once a settle ran clean for a given paid
 * sum, running it again for that same sum grants nothing: the read skips it.
 *
 * When does a gift land?
 *   - before: on the first account read after the payment (seconds), else the
 *     hourly sweep.
 *   - after:  the same. The first read after a payment sees a NEW paid sum, so it
 *     settles inline and the gift is in that very response. Every later read with
 *     the same paid sum skips the settle. The hourly sweep, the checkout route and
 *     the referral claim still settle unconditionally.
 *
 * The memo is per process: after a restart each org settles once on its first read.
 * Concurrent reads of one org share one in-flight settle instead of racing N.
 * A settle that THROWS is not memoised, so the next read retries it (fail loud
 * stays: the caller still 502s on the error).
 */
const lastSettledPaid = new Map<string, string>();
const inFlight = new Map<string, Promise<FreeCreditSettleResult>>();
const MEMO_MAX_ORGS = 50_000;

const SKIPPED: Pick<FreeCreditSettleResult, "grantedCents"> = {
  grantedCents: new Decimal(0).toFixed(10),
};

export async function settleFreeCreditPromisesIfPaidMoved(
  orgId: string,
  paidTopupsCents: string
): Promise<Pick<FreeCreditSettleResult, "grantedCents">> {
  const key = new Decimal(paidTopupsCents).toFixed(10);
  if (lastSettledPaid.get(orgId) === key) return SKIPPED;

  const pending = inFlight.get(orgId);
  if (pending) {
    // Another read of this org is settling right now: wait for it, grant nothing
    // here. Its grant is in ITS response; this read's ledger sum may or may not
    // already hold it, and folding it in again could count it twice. Same answer
    // a losing concurrent settle gave before ("already_granted").
    await pending;
    return SKIPPED;
  }

  const p = settleFreeCreditPromises(orgId, paidTopupsCents);
  inFlight.set(orgId, p);
  try {
    const r = await p;
    if (lastSettledPaid.size >= MEMO_MAX_ORGS) lastSettledPaid.clear();
    lastSettledPaid.set(orgId, key);
    return r;
  } finally {
    inFlight.delete(orgId);
  }
}

/** Test hook: forget every memoised settle. */
export function resetSettleMemoForTests(): void {
  lastSettledPaid.clear();
  inFlight.clear();
}
