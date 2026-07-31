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
 *   2. every earned REFERRAL promise — lib/free-credit-promises.ts, which also opens
 *      the inviter's promise the moment an invitee earns theirs.
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
  settleReferralPromises,
  type ReferralSettleResult,
} from "./free-credit-promises.js";
import {
  settleWelcomeCompletion,
  type WelcomeCompletionOutcome,
} from "./welcome-completion.js";

export interface FreeCreditSettleResult {
  /** Everything granted by THIS call, welcome + referral (canonical cents string). */
  grantedCents: string;
  welcome: WelcomeCompletionOutcome;
  referrals: ReferralSettleResult;
}

export async function settleFreeCreditPromises(
  orgId: string,
  paidTopupsCents: string,
  fetchPaidTopupsBeforeLaunchCents: () => Promise<string>
): Promise<FreeCreditSettleResult> {
  await ensureWelcomePromise(orgId);

  const welcome = await settleWelcomeCompletion(
    orgId,
    paidTopupsCents,
    fetchPaidTopupsBeforeLaunchCents
  );
  const referrals = await settleReferralPromises(orgId, paidTopupsCents);

  const grantedCents = new Decimal(welcome.amountCents)
    .plus(referrals.grantedCents)
    .toFixed(10);

  return { grantedCents, welcome, referrals };
}
