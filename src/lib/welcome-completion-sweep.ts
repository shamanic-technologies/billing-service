/**
 * Hourly welcome-completion sweep — the authoritative server-side driver for the
 * "$25 in free credits" completion gift.
 *
 * Billing learns about a Checkout payment lazily (stripe-service mirrors the
 * PaymentIntent; nothing pushes into billing). Every request path that already
 * holds the org's paid-topups sum settles the gift inline, which is what makes it
 * land within seconds of a purchase in practice. This sweep is what makes the
 * guarantee UNCONDITIONAL: an org that pays and never opens the app still gets its
 * credit, and a settle that failed once is retried on the next tick. No browser is
 * ever the trigger.
 *
 * Runs from the SAME hourly scheduler as dunning + the month-end sweep, isolated
 * in its own try/catch so neither can block the other.
 *
 * Candidate set = eligible accounts with no completion row yet (an org drops out
 * permanently once granted), so this costs one stripe-service paid-topups read per
 * not-yet-earned new signup per hour — bounded by signups, not by fleet size.
 *
 * Fail-loud per org, isolated: a per-org error is logged and skipped so one
 * unreachable org never blocks the rest (same shape as runDunningTick).
 */

import { sumSucceededTopupsForOrg } from "./stripe-service-client.js";
import {
  listWelcomeCompletionCandidates,
  settleWelcomeCompletion,
} from "./welcome-completion.js";

export interface WelcomeCompletionSweepResult {
  candidates: number;
  granted: number;
  failed: number;
}

export async function runWelcomeCompletionSweep(): Promise<WelcomeCompletionSweepResult> {
  const candidates = await listWelcomeCompletionCandidates();
  let granted = 0;
  let failed = 0;

  for (const orgId of candidates) {
    try {
      // User-less org-keyed read (X-API-Key + org only) — there is no end user on
      // this path, so no identity is invented. Net of refunds + lost disputes.
      const paidTopups = await sumSucceededTopupsForOrg(orgId);
      const outcome = await settleWelcomeCompletion(orgId, paidTopups);
      if (outcome.granted) {
        granted += 1;
        console.log(
          `[billing-service] welcome completion granted org=${orgId} amount_cents=${outcome.amountCents}`
        );
      }
    } catch (err) {
      failed += 1;
      console.error(
        `[billing-service] welcome-completion sweep failed for org ${orgId}:`,
        err
      );
    }
  }

  return { candidates: candidates.length, granted, failed };
}
