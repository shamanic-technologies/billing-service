/**
 * Off-session auto-topup reload: take `amountCents` from the org, whichever
 * acquirer holds its card, and report whether the money moved.
 *
 * That sentence is the whole contract, and it is deliberately the only thing
 * this module knows. Which vendor charges an org is stripe-service's business:
 * it resolves the acquirer itself on `POST /internal/charges/by-org/{orgId}`
 * and answers in ONE shape whatever it resolved. Nothing here names a vendor,
 * branches on one, or carries an acquirer-shaped field — an org can be moved to
 * a different acquirer with no change on this side.
 *
 * This replaces the older invoiced charge, whose whole purpose was producing a
 * finalized Stripe invoice document. That is a Stripe capability, and an
 * acquirer with no invoice object cannot serve an org through it. What this
 * call site actually wants is not a document: it is "take this much money,
 * off-session, and tell me whether it worked".
 *
 * The hosted document is NOT lost for an acquirer that produces one — the
 * neutral result reports where it lives, and reports its absence when the
 * acquirer has none. Absence means "this acquirer has no such thing", never
 * "the charge failed", which is exactly why this module reads the result's own
 * `status` and nothing else.
 *
 * Idempotency is unchanged: the caller's key is forwarded as `Idempotency-Key`,
 * so a retried top-up collapses onto the first charge rather than taking money
 * twice.
 *
 * Accounting: a succeeded charge is mirrored by stripe-service on the same
 * request, so billing's paid-topup sums count this top-up immediately — the
 * same as they did for the invoiced charge, whichever acquirer ran.
 */

import { chargeOrgOffSession } from "./stripe-service-client.js";
import type { ReloadOutcome } from "./reload-coalescer.js";

const RELOAD_CURRENCY = "usd";
/** Charge description (min length 1 required by stripe-service). */
const RELOAD_DESCRIPTION = "Distribute credit top-up";

/**
 * Charge `amountCents` off_session against the org's saved card via the
 * vendor-neutral charge surface. Synchronous: stripe-service takes the money
 * inline and returns the settled result.
 *
 * `orgId` is the whole identity this needs — the route is service-authenticated
 * with the org in its path, so there is no end user to name and none is
 * invented. Which payment method to charge is resolved by the acquirer that
 * holds it, not here.
 *
 * Caller MUST pass an idempotency key so retries collapse (no double charge).
 *
 * Throws if the org has no chargeable saved card, or if the charge is declined /
 * stripe-service errors (fail-loud). Caller's try/catch surfaces this as
 * topup_triggered=false / a 502.
 */
export async function reloadOffSession(
  orgId: string,
  amountCents: number,
  idempotencyKey: string,
  metadata?: Record<string, string>
): Promise<ReloadOutcome> {
  if (!orgId) {
    throw new Error("reloadOffSession: orgId is required");
  }
  const charge = await chargeOrgOffSession(
    orgId,
    {
      amount: amountCents,
      currency: RELOAD_CURRENCY,
      description: RELOAD_DESCRIPTION,
      metadata,
    },
    idempotencyKey
  );
  if (charge.status === "succeeded") {
    return { status: "succeeded", reference: charge.reference };
  }
  // stripe-service throws (non-2xx) on a declined off_session charge, so this
  // branch is defensive — a 200 carrying a non-succeeded status is still a
  // failed reload.
  return {
    status: "failed",
    reference: charge.reference,
    failure_reason: `charge.status=${charge.status ?? "unknown"}`,
  };
}
