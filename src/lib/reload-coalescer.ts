/**
 * In-memory per-org reload coalescer + post-failure backoff.
 *
 * TWO guarantees, both per-org, both in memory:
 *
 * 1. COALESCING — N concurrent authorize calls for the same org fire ONE
 *    PaymentIntent; the rest join the same promise and read the result.
 *
 * 2. BACKOFF — after a reload FAILS, the org is refused a new charge attempt
 *    for a growing cooldown. Coalescing alone only dedupes calls that overlap
 *    in TIME: the in-flight entry was dropped the moment the promise settled,
 *    so a declined card left zero memory and the very next authorize charged
 *    it again. Prod, 2026-08-29: one org accumulated 61 declined $500 charges
 *    in six hours (one per minute in bursts), and the issuer escalated from
 *    `insufficient_funds` to a flat `generic_decline` — repeated declines
 *    degrade the card at its issuer and our decline rate at Stripe, so the
 *    retries actively made recovery harder. Nothing was over-collected; the
 *    damage is the hammering itself.
 *
 * A card that just declined declines again a minute later, so the cooldown is
 * keyed on the ORG alone — never on the amount, or a different tier amount
 * would walk straight past it.
 *
 * Single-instance billing assumption, same as the coalescing above. Multi-
 * instance horizontal scaling: both must move into stripe-service (Redis
 * mutex + failure marker per org); this module becomes a no-op cache then.
 */

export interface ReloadOutcome {
  status: "succeeded" | "failed";
  payment_intent_id?: string;
  failure_reason?: string;
  /**
   * True ONLY on an outcome synthesised by the backoff — no charge was
   * attempted and no new information was learned. Callers use it to stay quiet
   * (the customer was already told when the real failure happened); every
   * other reaction to a failed reload is unchanged. Absent on a real outcome.
   */
  backoffSkipped?: boolean;
}

/**
 * Cooldown after the Nth consecutive failure. Grows so a persistently dead
 * card stops costing attempts, and is CAPPED so an org that fixes its card
 * resumes on its own within the hour rather than staying locked out. The first
 * step is deliberately short: a failure can also be a transient stripe-service
 * error, and 5 minutes is the right answer for that case too.
 */
const BACKOFF_STEPS_MS = [
  5 * 60_000, // 1st failure  → 5 min
  15 * 60_000, // 2nd          → 15 min
  30 * 60_000, // 3rd          → 30 min
  60 * 60_000, // 4th and beyond → 1 h (cap)
] as const;

interface FailureState {
  consecutiveFailures: number;
  blockedUntilMs: number;
}

const inFlight = new Map<string, Promise<ReloadOutcome>>();
const failures = new Map<string, FailureState>();

function cooldownFor(consecutiveFailures: number): number {
  const i = Math.min(consecutiveFailures, BACKOFF_STEPS_MS.length) - 1;
  return BACKOFF_STEPS_MS[Math.max(i, 0)];
}

function recordFailure(orgId: string, nowMs: number): void {
  const consecutiveFailures = (failures.get(orgId)?.consecutiveFailures ?? 0) + 1;
  failures.set(orgId, {
    consecutiveFailures,
    blockedUntilMs: nowMs + cooldownFor(consecutiveFailures),
  });
}

/** A charge that went through clears the whole history — the card works. */
function recordSuccess(orgId: string): void {
  failures.delete(orgId);
}

/**
 * Milliseconds until this org may be charged again, or 0 when it may be
 * charged now. Exported so callers can log/trace WHY a reload was skipped.
 */
export function reloadBlockedForMs(orgId: string, nowMs: number = Date.now()): number {
  const state = failures.get(orgId);
  if (!state) return 0;
  const remaining = state.blockedUntilMs - nowMs;
  if (remaining <= 0) {
    // Cooldown elapsed. Keep the failure COUNT so the next failure escalates
    // rather than restarting at 5 minutes; only a success clears it.
    return 0;
  }
  return remaining;
}

export async function coalesceReload(
  orgId: string,
  fn: () => Promise<ReloadOutcome>
): Promise<ReloadOutcome> {
  const existing = inFlight.get(orgId);
  if (existing) return existing;

  const blockedForMs = reloadBlockedForMs(orgId);
  if (blockedForMs > 0) {
    const state = failures.get(orgId);
    return {
      status: "failed",
      backoffSkipped: true,
      failure_reason:
        `reload_backoff: ${state?.consecutiveFailures ?? 0} consecutive failures, ` +
        `retry in ${Math.ceil(blockedForMs / 1000)}s`,
    };
  }

  // A DECLINED off_session charge reaches us as a THROW (stripe-service answers
  // non-2xx), so the backoff has to arm on the rejection path — arming only on a
  // settled {status:"failed"} would miss every real card decline. The error is
  // re-thrown untouched, so every caller's existing try/catch behaves as before.
  const promise = fn()
    .then((outcome) => {
      if (outcome.status === "succeeded") recordSuccess(orgId);
      else recordFailure(orgId, Date.now());
      return outcome;
    })
    .catch((err) => {
      recordFailure(orgId, Date.now());
      throw err;
    })
    .finally(() => {
      inFlight.delete(orgId);
    });
  inFlight.set(orgId, promise);
  return promise;
}

/** Test-only: clear all in-flight entries and backoff state. */
export function _resetCoalescer(): void {
  inFlight.clear();
  failures.clear();
}
