/**
 * Hourly free-credit sweep — the authoritative server-side driver for every
 * outstanding free-credit promise (the welcome completion and every referral).
 *
 * Billing learns about a Checkout payment lazily (stripe-service mirrors the
 * PaymentIntent; nothing pushes into billing). Every request path that already holds
 * the org's paid-topups sum settles inline, which is what makes a gift land within
 * seconds of a purchase in practice. This sweep is what makes the guarantee
 * UNCONDITIONAL: an org that pays and never opens the app still gets its credit, a
 * settle that failed once is retried on the next tick, and an inviter's promise still
 * opens even if the invitee never returns to the dashboard. No browser is ever the
 * trigger.
 *
 * Runs from the SAME hourly scheduler as dunning + the month-end sweep, isolated in
 * its own try/catch so neither can block the other.
 *
 * Candidate set = every org that still has something coming:
 *   - eligible accounts with no completion row yet (an org drops out permanently once
 *     granted, or once the grandfather check excludes it), and
 *   - orgs holding an outstanding promise row, or a granted referral whose inviter
 *     promise has not been opened yet.
 * So this costs one stripe-service paid-topups read per hour per org that genuinely
 * still has credit coming.
 *
 * Fail-loud per org, isolated: a per-org error is logged and skipped so one
 * unreachable org never blocks the rest (same shape as runDunningTick).
 */

import { sumSucceededTopupsForOrg } from "./stripe-service-client.js";
import { listWelcomeCompletionCandidates } from "./welcome-completion.js";
import { listPromiseSweepCandidates } from "./free-credit-promises.js";
import { settleFreeCreditPromises } from "./free-credit-settlement.js";

export interface WelcomeCompletionSweepResult {
  candidates: number;
  granted: number;
  failed: number;
}

export async function runWelcomeCompletionSweep(): Promise<WelcomeCompletionSweepResult> {
  const [welcomeCandidates, promiseCandidates] = await Promise.all([
    listWelcomeCompletionCandidates(),
    listPromiseSweepCandidates(),
  ]);
  const candidates = [...new Set([...welcomeCandidates, ...promiseCandidates])];
  let granted = 0;
  let failed = 0;

  for (const orgId of candidates) {
    try {
      // User-less org-keyed read (X-API-Key + org only) — there is no end user on
      // this path, so no identity is invented. Net of refunds + lost disputes.
      const paidTopups = await sumSucceededTopupsForOrg(orgId);
      const outcome = await settleFreeCreditPromises(orgId, paidTopups);
      if (outcome.welcome.granted) {
        granted += 1;
        console.log(
          `[billing-service] welcome completion granted org=${orgId} amount_cents=${outcome.welcome.amountCents}`
        );
      }
      for (const promise of outcome.referrals.granted) {
        granted += 1;
        console.log(
          `[billing-service] referral promise granted org=${orgId} promise=${promise.id} ` +
            `amount_cents=${promise.amountCents} referred_org=${promise.referredOrgId ?? "none"}`
        );
      }
      if (outcome.referrals.inviterPromisesOpened > 0) {
        console.log(
          `[billing-service] inviter promises opened by org=${orgId}: ${outcome.referrals.inviterPromisesOpened}`
        );
      }
    } catch (err) {
      failed += 1;
      console.error(
        `[billing-service] free-credit promise sweep failed for org ${orgId}:`,
        err
      );
    }
  }

  return { candidates: candidates.length, granted, failed };
}
