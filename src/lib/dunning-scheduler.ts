/**
 * In-process dunning scheduler (issue #147).
 *
 * Mirrors campaign-service's pattern: a self-rescheduling setTimeout loop
 * started after migrate(), before app.listen(). Non-blocking — the first tick
 * is deferred so boot binds the port immediately. Runs hourly: follow-ups are
 * days apart, so an hourly cadence gives crisp stop-on-recharge (≤1h) while
 * letting Neon's compute suspend between ticks. Multiple replicas are safe —
 * every send is atomic-claimed in runDunningTick.
 */

import { runDunningTick } from "./dunning.js";
import { runMonthEndSweep } from "./month-end-sweep.js";
import { runWelcomeCompletionSweep } from "./welcome-completion-sweep.js";
import { runUnpaidDebtScan } from "./unpaid-debt.js";
import { runCampaignReloadSweep } from "./campaign-reload-sweep.js";
import { runSubscriptionSweep } from "./subscription.js";
import { reallocateDerivedPlans, restateSubscriberBudgetsFromPlans } from "./subscriber-plan-budgets.js";
import { notifySubscriptionCreditsUsedIfDue } from "./subscription-notifications.js";
import { notifySubscriptionMonthlyUpdateIfDue } from "./subscription-monthly-update.js";

// Hourly heartbeat. The follow-up windows (+3d / +10d) are far coarser, so this
// is plenty frequent for both follow-ups and recharge detection.
export const TICK_INTERVAL_MS = 60 * 60 * 1000;
// Defer the first tick so it never runs inside the boot/migrate window.
const INITIAL_DELAY_MS = 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export function startDunningScheduler(): void {
  const tick = async () => {
    try {
      try {
        const r = await runDunningTick();
        if (r.processed > 0) {
          console.log(
            `[billing-service] dunning tick: processed=${r.processed} recovered=${r.recovered} ` +
              `3d=${r.followup3dSent} 10d=${r.followup10dSent}`
          );
        }
      } catch (err) {
        console.error("[billing-service] dunning tick failed:", err);
      }

      // Month-end forced top-up sweep. Self-gates on the last UTC day of the
      // month — a cheap date check on every other tick. Isolated from dunning so
      // a failure in either never blocks the other.
      try {
        const s = await runMonthEndSweep();
        if (s.ranSweep && (s.charged > 0 || s.failed > 0)) {
          console.log(
            `[billing-service] month-end sweep: eligible=${s.eligible} ` +
              `charged=${s.charged} skipped=${s.skipped} failed=${s.failed}`
          );
        }
      } catch (err) {
        console.error("[billing-service] month-end sweep failed:", err);
      }

      // Unpaid-debt scan — every org that owes money with no chargeable card
      // gets flagged, told, and made visible to staff. This is the BACKSTOP for
      // "the last card was lost": stripe-service calls
      // POST /internal/payment-methods/lost the moment it happens, and this
      // catches the org that went into debt while already card-less, refreshes
      // the amount owed, and clears the flag when a card comes back. Isolated so
      // a failure here never blocks the other sweeps, and vice-versa.
      try {
        const d = await runUnpaidDebtScan();
        if (d.flagged > 0 || d.failed > 0) {
          console.log(
            `[billing-service] unpaid-debt scan: scanned=${d.scanned} ` +
              `flagged=${d.flagged} alreadyFlagged=${d.alreadyFlagged} failed=${d.failed}`
          );
        }
      } catch (err) {
        console.error("[billing-service] unpaid-debt scan failed:", err);
      }

      // Blocked-campaign reload sweep — fires the reload `authorize` would have
      // fired for a campaign the read-only affordability pre-flight is refusing.
      // That refusal IS the authorize reload condition, but campaign-service
      // never dispatches the run, so authorize is never reached and the org sits
      // in the band [floor, floor + estimate) indefinitely. This is what bounds
      // that state to one tick. Isolated so a failure here never blocks the
      // other sweeps, and vice-versa.
      try {
        const c = await runCampaignReloadSweep();
        if (c.blocked > 0) {
          console.log(
            `[billing-service] campaign reload sweep: scanned=${c.scanned} ` +
              `blocked=${c.blocked} charged=${c.charged} ` +
              `notReloadCapable=${c.notReloadCapable} awaitingRetry=${c.awaitingRetry} ` +
              `exhausted=${c.exhausted} cardUnusable=${c.cardUnusable} ` +
              `failed=${c.failed}`
          );
        }
      } catch (err) {
        console.error("[billing-service] campaign reload sweep failed:", err);
      }

      // Welcome-completion sweep — the unconditional server-side driver for the
      // "$25 in free credits" completion gift. Isolated so a failure here never
      // blocks dunning or the month-end sweep, and vice-versa.
      try {
        const w = await runWelcomeCompletionSweep();
        if (w.granted > 0 || w.failed > 0) {
          console.log(
            `[billing-service] welcome-completion sweep: candidates=${w.candidates} ` +
              `granted=${w.granted} failed=${w.failed}`
          );
        }
      } catch (err) {
        console.error("[billing-service] welcome-completion sweep failed:", err);
      }

      // A subscriber's campaign budgets come from its plan (lib/subscriber-plan-budgets):
      // legacy daily ceilings are restated as monthly figures derived from the live
      // plan, never charged. Before the subscription sweep, so a renewal reads them.
      try {
        const b = await restateSubscriberBudgetsFromPlans(new Date());
        if (b.offers > 0) {
          console.log(
            `[billing-service] plan budgets: offers=${b.offers} restatedOffers=${b.restatedOffers} ` +
              `restatedOrgs=${b.restatedOrgs} rowsRestated=${b.rowsRestated} rowsDeleted=${b.rowsDeleted} skipped=${b.skipped}`
          );
        }
      } catch (err) {
        console.error("[billing-service] plan budgets sweep failed:", err);
      }
      // Plan-derived offers follow the CURRENT allocation rule (follow-up = 9% of the
      // plan, entries the rest): an offer already on it writes nothing.
      try {
        const d = await reallocateDerivedPlans(new Date());
        if (d.reallocatedOffers > 0 || d.skipped > 0) {
          console.log(
            `[billing-service] derived plans: offers=${d.offers} reallocatedOffers=${d.reallocatedOffers} skipped=${d.skipped}`
          );
        }
      } catch (err) {
        console.error("[billing-service] derived plans sweep failed:", err);
      }

      // Subscription sweep — starts subscriptions whose card is now on file, expires
      // unspent credit and bills each renewal, retries refused charges on their rungs,
      // sends the once-a-period "credits used" email, and the informational monthly
      // update once each period closes (lib/subscription-monthly-update). Isolated
      // like the others.
      try {
        const s = await runSubscriptionSweep(new Date(), async (orgId, sub) => {
          await notifySubscriptionMonthlyUpdateIfDue(orgId, sub);
          await notifySubscriptionCreditsUsedIfDue(orgId, sub);
        });
        if (s.checked > 0) {
          console.log(
            `[billing-service] subscription sweep: checked=${s.checked} failed=${s.failed}`
          );
        }
      } catch (err) {
        console.error("[billing-service] subscription sweep failed:", err);
      }
    } finally {
      timer = setTimeout(tick, TICK_INTERVAL_MS);
    }
  };

  timer = setTimeout(tick, INITIAL_DELAY_MS);
  console.log("[billing-service] dunning scheduler started");
}

export function stopDunningScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
