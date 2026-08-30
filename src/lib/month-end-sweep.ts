/**
 * Month-end forced top-up sweep.
 *
 * Threshold-based postpaid top-up (see lib/topup-tier) lets an org's balance run
 * NEGATIVE down to a derived credit-line floor; a reload fires only when spend
 * crosses that floor. A slow spender who never crosses the floor within a
 * calendar month would go a whole month un-charged. Google/Meta Ads sweep any
 * outstanding spend on the monthly bill date regardless of amount — this
 * replicates that: once a month, settle every reload-capable org whose balance is
 * negative by charging EXACTLY the outstanding amount, back to 0.
 *
 * Runs from the hourly dunning scheduler (post-listen, never the boot path). It
 * self-gates on ONE tick — the last calendar day of the month, at
 * SWEEP_HOUR_UTC — so on every other tick it is a single date check and returns
 * immediately. See isSweepTick for why the hour is part of the gate.
 *
 * Idempotency: the primary guard is the balance re-check itself — once the first
 * charge lands, `credited` rises and the org reads non-negative, so later ticks
 * skip it. A Stripe idempotency key scoped to (org, month, amount) covers the
 * mirror-sync-lag window on top of that: a re-tick before the charge is mirrored
 * reads the same balance, so it computes the same amount, hits the same key and
 * collapses onto the one invoice. Every tick of the sweep hour falls inside
 * Stripe's ~24h key retention. The amount is IN the key on purpose — see
 * sweepIdempotencyKey. No new storage.
 *
 * No cost declaration: a reload collects the org's OWN money via Stripe (the org
 * paid its provider) — it is not a metered platform cost, exactly like the
 * authorize / usage_apply reloads. Matches that path's absence of a runs-service
 * cost row.
 */

import crypto from "crypto";
import { Decimal } from "decimal.js";
import { and, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { computeBalance } from "./balance.js";
import { cmpCents } from "./cents.js";
import { coalesceReload } from "./reload-coalescer.js";
import { reloadOffSession } from "./reload.js";


// A hung stripe-service call must not stall the whole sweep loop.
const RELOAD_TIMEOUT_MS = 30_000;

/**
 * Stripe's minimum card charge in USD (50 cents). A smaller amount is rejected
 * outright (`amount_too_small`), so a deficit under it cannot be settled — it
 * simply rolls into the next month's sweep.
 */
export const STRIPE_MIN_CHARGE_CENTS = 50;

/**
 * Cents to charge to settle `balanceCents` back to exactly 0.
 *
 * The sweep exists to collect OUTSTANDING SPEND, so it bills the deficit itself —
 * NOT a multiple of the org's postpaid tier amount. Tier multiples belong to the
 * in-month reload paths (authorize / usage_apply), where a charge buys back one
 * crossed notch of the credit line; on the monthly settle there is no line to
 * restore, only a balance to zero. Charging a $50/$200/$500 multiple here
 * over-collects from every org whose deficit is smaller than one notch — on
 * 2026-07-31 that billed a -$9.61 org $50 and a -$325.93 org $500, $283.39 of
 * over-collection across four orgs.
 *
 * Fractional cents round UP (Stripe charges whole cents, and rounding down would
 * leave the org a fraction negative, re-arming the sweep next month for pennies).
 * Returns 0 when the balance is already non-negative, or when the deficit sits
 * below Stripe's minimum charge.
 */
export function computeSettleCharge(balanceCents: string): number {
  const deficit = new Decimal(balanceCents).negated();
  if (deficit.lessThanOrEqualTo(0)) return 0;
  const cents = deficit.toDecimalPlaces(0, Decimal.ROUND_CEIL).toNumber();
  return cents < STRIPE_MIN_CHARGE_CENTS ? 0 : cents;
}

/**
 * True iff `date` is the last calendar day of its month in UTC.
 *
 * Adding one UTC day rolls into the next month ONLY on the last day. Date.UTC
 * normalizes day overflow (day 32 → next month), so this is exact across
 * 28/29/30/31-day months (and Feb 29 in leap years) with no ms arithmetic.
 */
export function isLastDayOfMonth(date: Date): boolean {
  const m = date.getUTCMonth();
  const next = new Date(
    Date.UTC(date.getUTCFullYear(), m, date.getUTCDate() + 1)
  );
  return next.getUTCMonth() !== m;
}

/**
 * The single UTC hour of the last day on which the sweep charges. 23:00 puts it
 * at the close of the accounting month, so the deficit it settles is the whole
 * month's outstanding spend.
 */
export const SWEEP_HOUR_UTC = 23;

/**
 * True iff `date` is the ONE hourly tick the sweep is allowed to charge on.
 *
 * The day gate alone is NOT enough, and that is the whole reason this exists.
 * The sweep runs on the hourly dunning tick, and its idempotency rests on the
 * balance re-check ("once the charge lands the org reads non-negative, so later
 * ticks skip it"). That holds only for an org that stops spending. An org still
 * consuming goes negative again within the hour, so a day-only gate re-charges
 * it on EVERY remaining tick of the last day — up to 24 separate card charges
 * for one month's spend.
 *
 * That is what prod did on 2026-07-31: one org was charged three times in seven
 * hours ($500 → $174.07 refunded, then $1.00, then $20.00), each amount a
 * correct deficit, the total correct, and the customer's statement a mess. The
 * bug is fragmentation, not over-collection — which is why it survived both the
 * exact-deficit fix and the idempotency-key fix that shipped the same day.
 *
 * Restricting to one tick per month needs no new state: a missed sweep (service
 * restarting through the hour) is not lost revenue, because the balance is
 * cumulative — the next month's sweep collects the larger deficit, and in-month
 * exposure stays bounded by the postpaid credit-line floor, which keeps firing
 * its own reload the whole time. Residual: a restart inside the sweep hour
 * re-ticks 60s after boot; the Stripe key collapses it when the deficit is
 * unchanged.
 */
export function isSweepTick(date: Date): boolean {
  return isLastDayOfMonth(date) && date.getUTCHours() === SWEEP_HOUR_UTC;
}

/** "YYYY-MM" bucket (UTC) — the idempotency scope for one calendar month. */
export function monthBucket(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Stripe idempotency key scoped to (org, month, charge amount).
 *
 * stripe-service derives one Stripe key per step from this single key
 * (`:invoice` / `:item` / `:finalize` / `:pay`), and Stripe rejects a replayed
 * key whose parameters changed. `invoiceItems.create` carries the amount, so an
 * AMOUNT-INDEPENDENT key (what this used to be) makes a second sweep charge of a
 * DIFFERENT amount in the same month impossible: Stripe 400s with "Keys for
 * idempotent requests can only be used with the same parameters they were first
 * used with" and the org goes uncollected for the rest of the month. Worse, step
 * 1 (`invoices.create`) carries no amount, so it REPLAYS the first attempt's
 * invoice — which may since have been voided or paid.
 *
 * That fired in prod on 2026-07-31: the over-collection hotfix changed the
 * computed amount mid-month, so the corrected charge collided with the key its
 * own over-charge had burned (`failed=3, charged=0`) — including one org whose
 * replayed invoice was by then void.
 *
 * Including the amount keeps every case the month bucket was there for:
 * concurrent replicas compute the same deficit from the same balance, and a
 * re-tick during mirror-sync lag reads an unchanged balance, so both produce the
 * SAME amount and collapse onto one Stripe invoice. What it no longer does is
 * block a legitimately different amount — a corrected charge, or a fresh deficit
 * after a refund. Residual: if a charge lands, is not yet mirrored, AND usage
 * accrues before the next hourly tick, the deficit differs and a second charge
 * is possible; the balance re-check is the guard, and the mirror is
 * webhook-driven (seconds) against an hourly tick.
 */
export function sweepIdempotencyKey(
  orgId: string,
  bucket: string,
  chargeAmountCents: number
): string {
  return crypto
    .createHash("sha256")
    .update(`month-end-sweep:${orgId}:${bucket}:${chargeAmountCents}`)
    .digest("hex")
    .slice(0, 32);
}

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`month-end sweep reload timeout after ${ms}ms`)),
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

export interface MonthEndSweepResult {
  /** False when `now` is not the month's single sweep tick — the sweep no-ops. */
  ranSweep: boolean;
  /** Auto-topup-enabled accounts examined. */
  eligible: number;
  /** Orgs charged one settling reload. */
  charged: number;
  /** Orgs skipped (non-negative balance, no card, blocked country, zero charge). */
  skipped: number;
  /** Orgs whose reload errored / declined (logged + isolated). */
  failed: number;
}

/**
 * Settle every reload-capable org with a negative balance, on the month's single
 * sweep tick. Per-org failure is logged and skipped — one unreachable org never
 * blocks the rest (same shape as runDunningTick).
 */
export async function runMonthEndSweep(
  now: Date = new Date()
): Promise<MonthEndSweepResult> {
  const result: MonthEndSweepResult = {
    ranSweep: false,
    eligible: 0,
    charged: 0,
    skipped: 0,
    failed: 0,
  };

  if (!isSweepTick(now)) return result;
  result.ranSweep = true;
  const bucket = monthBucket(now);

  // Auto-topup ENABLED accounts only (both config columns non-null ⇒ enabled,
  // mirroring the usage_apply gate). Reload-capability (chargeable card +
  // non-blocked issuing country) is re-checked per org below against the live
  // Stripe snapshot.
  const enabled = await db
    .select()
    .from(billingAccounts)
    .where(
      and(
        isNotNull(billingAccounts.topupAmountCents),
        isNotNull(billingAccounts.topupThresholdCents)
      )
    );

  for (const account of enabled) {
    result.eligible += 1;
    try {
      const snapshot = await computeBalance(account.orgId);

      // Reload-capable guards — mirror usage_apply: chargeable card AND an
      // issuing country that supports off_session charges (India/RBI excluded).
      if (!snapshot.hasCardPm || !snapshot.autoReloadSupported) {
        result.skipped += 1;
        continue;
      }

      // Only settle a NEGATIVE balance (outstanding spend on credit that never
      // crossed the floor). A non-negative org owes nothing this cycle — the
      // normal floor-crossing path owns anything already past the floor.
      if (cmpCents(snapshot.balanceCents, "0") >= 0) {
        result.skipped += 1;
        continue;
      }

      // Charge EXACTLY the outstanding amount, settling the balance back to 0.
      const chargeAmount = computeSettleCharge(snapshot.balanceCents);
      if (chargeAmount <= 0) {
        // Only reachable below Stripe's minimum charge (the non-negative case
        // returned above) — the remainder rolls into next month's sweep.
        console.log(
          `[billing-service] month-end sweep: org ${account.orgId} owes ` +
            `${snapshot.balanceCents} cents, below the ` +
            `${STRIPE_MIN_CHARGE_CENTS}-cent Stripe minimum — skipped (${bucket})`
        );
        result.skipped += 1;
        continue;
      }

      const outcome = await coalesceReload(account.orgId, () =>
        withTimeout(
          RELOAD_TIMEOUT_MS,
          reloadOffSession(
            account.orgId,
            chargeAmount,
            sweepIdempotencyKey(account.orgId, bucket, chargeAmount),
            { reason: "month_end_sweep", month: bucket }
          )
        )
      );

      if (outcome.status === "succeeded") {
        result.charged += 1;
        console.log(
          `[billing-service] month-end sweep: charged org ${account.orgId} ` +
            `${chargeAmount} cents (${bucket})`
        );
      } else {
        result.failed += 1;
        console.warn(
          `[billing-service] month-end sweep: reload ${outcome.status} for org ` +
            `${account.orgId}: ${outcome.failure_reason ?? ""}`
        );
      }
    } catch (err) {
      result.failed += 1;
      console.error(
        `[billing-service] month-end sweep failed for org ${account.orgId}, ` +
          `skipping:`,
        err
      );
      continue;
    }
  }

  return result;
}
