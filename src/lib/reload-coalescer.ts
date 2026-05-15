/**
 * In-memory per-org reload coalescer.
 *
 * Single-instance billing assumption: if N concurrent authorize calls for the
 * same org all need a topup, only ONE PaymentIntent fires. The rest join the
 * same promise and read the result.
 *
 * Multi-instance horizontal scaling: dedup must move into stripe-service
 * (mutex Redis per-org + Stripe idempotency key). Coalescer becomes a no-op
 * cache then.
 */

export interface ReloadOutcome {
  status: "succeeded" | "failed";
  payment_intent_id?: string;
  failure_reason?: string;
}

const inFlight = new Map<string, Promise<ReloadOutcome>>();

export async function coalesceReload(
  orgId: string,
  fn: () => Promise<ReloadOutcome>
): Promise<ReloadOutcome> {
  const existing = inFlight.get(orgId);
  if (existing) return existing;

  const promise = fn().finally(() => {
    inFlight.delete(orgId);
  });
  inFlight.set(orgId, promise);
  return promise;
}

/** Test-only: clear all in-flight entries. */
export function _resetCoalescer(): void {
  inFlight.clear();
}
