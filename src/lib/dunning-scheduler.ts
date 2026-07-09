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
