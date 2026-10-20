/**
 * On-demand off-session charge: take a STATED amount from the org's saved card
 * right now and credit the org balance exactly like an ordinary topup.
 *
 * Consumer: the api-service gateway, on behalf of the rebuilt sell-first
 * onboarding. The first purchase is paid through hosted Checkout (which also
 * saves the card); later ones are paid one call at a time through this, without
 * a second redirect.
 *
 * NO second Stripe integration: the charge itself is the existing
 * `reloadOffSession` path — the same `POST /internal/charges/by-org/{orgId}`
 * stripe-service route, the same vendor-neutral charge, the same idempotency
 * forwarding. A succeeded charge is mirrored by stripe-service on the same
 * request, so billing's paid-topup sums (and therefore `credited` and
 * `balance`) rise immediately, exactly like an ordinary topup.
 *
 * `computeBalance` runs first so every failure the caller can act on is named
 * BEFORE any money is attempted:
 *   - no chargeable saved card → `no_chargeable_payment_method`
 *   - saved card whose issuing country cannot be charged off_session (India /
 *     RBI) → `card_not_chargeable_off_session` (the charge would be declined
 *     by construction; attempting it teaches nobody anything)
 * The charge going through still runs via `coalesceReload`, so it shares the
 * per-org coalescing + post-failure backoff with the auto-reload paths — a
 * card that just declined to the sweep is not hammered again seconds later by
 * an onboarding payment.
 *
 * Fail-loud and DISTINGUISHABLE: every outcome carries a stable `code` the
 * caller can branch on (see OnDemandChargeCode). A decline is never a silent
 * no-op and never a generic 502 — the dashboard's fallback to hosted checkout
 * depends on telling "card declined" from "billing/stripe-service is down".
 */

import crypto from "crypto";
import { computeBalance } from "./balance.js";
import { STRIPE_MIN_CHARGE_CENTS } from "./month-end-sweep.js";
import { reloadOffSession } from "./reload.js";
import { coalesceReload } from "./reload-coalescer.js";

/** A hung stripe-service call must not hold the gateway call forever. */
const CHARGE_TIMEOUT_MS = 30_000;
/** Same bucket shape as the reload paths — a retry within the window collapses. */
const IDEMPOTENCY_BUCKET_MS = 60_000;

export type OnDemandChargeCode =
  /** stripe-service answered that the money could not be taken (card declined). */
  | "charge_declined"
  /** No chargeable saved payment method exists for this org. */
  | "no_chargeable_payment_method"
  /** A card exists but its issuing country cannot be charged off_session. */
  | "card_not_chargeable_off_session"
  /** A recent reload failure put this org in backoff — no charge attempted. */
  | "charge_backoff"
  /** stripe-service (or another upstream) could not be asked or errored. */
  | "upstream_error";

/**
 * Thrown for every on-demand charge that does not land. `code` is stable and
 * the route maps it to a distinct HTTP status, so a decline is distinguishable
 * from a success, from "no card", and from an upstream outage on the wire.
 */
export class OnDemandChargeError extends Error {
  readonly code: OnDemandChargeCode;
  readonly amountCents: number;

  constructor(params: {
    code: OnDemandChargeCode;
    amountCents: number;
    message: string;
  }) {
    super(params.message);
    this.name = "OnDemandChargeError";
    this.code = params.code;
    this.amountCents = params.amountCents;
  }
}

/**
 * Idempotency key for one on-demand topup, scoped to (org, amount, minute
 * bucket) — the same shape the auto-reload uses. A caller retry inside the
 * window collapses onto the first charge; a genuinely new charge of the same
 * amount a minute later still goes through. A caller-supplied key (body
 * `idempotencyKey`) is forwarded verbatim instead.
 */
export function onDemandChargeIdempotencyKey(
  orgId: string,
  amountCents: number
): string {
  const bucket = Math.floor(Date.now() / IDEMPOTENCY_BUCKET_MS);
  return crypto
    .createHash("sha256")
    .update(`on-demand-topup:${orgId}:${amountCents}:${bucket}`)
    .digest("hex")
    .slice(0, 32);
}

function statusFromUpstreamError(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  // `call` throws `stripe-service <METHOD> <path> failed: <status> <text>`.
  const m = msg.match(/stripe-service .* failed: (\d{3})/);
  return m ? Number(m[1]) : null;
}

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`on-demand charge timeout after ${ms}ms`)),
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

export interface OnDemandChargeResult {
  charged: true;
  amountCents: number;
  /** The acquirer's own id for the charge (support/reconciliation only). */
  reference: string;
}

/**
 * Charge `amountCents` off-session against the org's saved card, now.
 *
 * Throws `OnDemandChargeError` when the charge does not land (declined, no
 * card, backoff, upstream error) — the route turns that into a distinct
 * non-2xx. Throws plain Errors only for programming misuse (bad amount).
 */
export async function chargeOrgOnDemand(
  orgId: string,
  amountCents: number,
  idempotencyKey?: string
): Promise<OnDemandChargeResult> {
  if (!orgId) {
    throw new Error("chargeOrgOnDemand: orgId is required");
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error("chargeOrgOnDemand: amountCents must be a positive integer");
  }
  if (amountCents < STRIPE_MIN_CHARGE_CENTS) {
    throw new Error(
      `chargeOrgOnDemand: amountCents below the ${STRIPE_MIN_CHARGE_CENTS}-cent Stripe minimum`
    );
  }

  // Pre-flight guards, read BEFORE any money is attempted so every actionable
  // failure has a name. computeBalance is the same snapshot the reload paths
  // gate on (hasCardPm + autoReloadSupported).
  const snapshot = await computeBalance(orgId);
  if (!snapshot.hasCardPm) {
    throw new OnDemandChargeError({
      code: "no_chargeable_payment_method",
      amountCents,
      message: "This org has no chargeable saved payment method",
    });
  }
  if (!snapshot.autoReloadSupported) {
    throw new OnDemandChargeError({
      code: "card_not_chargeable_off_session",
      amountCents,
      message: `The saved card (issuing country ${
        snapshot.cardCountry ?? "unknown"
      }) cannot be charged off_session`,
    });
  }

  const key = idempotencyKey?.trim()
    ? idempotencyKey.trim()
    : onDemandChargeIdempotencyKey(orgId, amountCents);

  let outcome;
  try {
    outcome = await coalesceReload(orgId, () =>
      withTimeout(
        CHARGE_TIMEOUT_MS,
        reloadOffSession(orgId, amountCents, key, {
          reason: "on_demand_topup",
        })
      )
    );
  } catch (err) {
    // A declined off_session charge arrives as a THROW (stripe-service answers
    // non-2xx) — the ordinary decline case, not an exotic one.
    const status = statusFromUpstreamError(err);
    if (status === 402) {
      throw new OnDemandChargeError({
        code: "charge_declined",
        amountCents,
        message: `The saved card declined the ${amountCents}-cent charge`,
      });
    }
    if (status === 404 || status === 409) {
      throw new OnDemandChargeError({
        code: "no_chargeable_payment_method",
        amountCents,
        message: "The acquirer holds no chargeable payment method for this org",
      });
    }
    throw new OnDemandChargeError({
      code: "upstream_error",
      amountCents,
      message: `Failed to charge the saved card: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  if (outcome.status !== "succeeded") {
    throw new OnDemandChargeError({
      code: outcome.backoffSkipped ? "charge_backoff" : "charge_declined",
      amountCents,
      message: `Charge did not land: ${outcome.failure_reason ?? outcome.status}`,
    });
  }

  return {
    charged: true,
    amountCents,
    reference: outcome.reference ?? "",
  };
}
