/**
 * Month-end forced top-up sweep.
 *
 * Threshold-based postpaid top-up (see lib/topup-tier) lets an org's balance run
 * NEGATIVE down to a derived credit-line floor; a reload fires only when spend
 * crosses that floor. A slow spender who never crosses the floor within a
 * calendar month would go a whole month un-charged. Google/Meta Ads sweep any
 * outstanding spend on the monthly bill date regardless of amount — this
 * replicates that: once a month, settle every reload-capable org whose balance is
 * negative by forcing ONE tier-amount reload back to >= 0.
 *
 * Runs from the hourly dunning scheduler (post-listen, never the boot path). It
 * self-gates on the last calendar day of the month (UTC), so on any other day it
 * is a single date check and returns immediately.
 *
 * Idempotency: a month-bucketed ("YYYY-MM") Stripe idempotency key collapses any
 * two sweep charges for the same org in the same month into ONE PaymentIntent.
 * The primary guard is the balance re-check itself — once the first charge lands,
 * `credited` rises and the org reads non-negative, so later ticks skip it. The
 * month-bucketed key covers the mirror-sync-lag window: all last-day ticks fall
 * inside Stripe's ~24h idempotency-key retention, so a same-day double tick (even
 * across replicas) can never double-charge. No new storage.
 *
 * No cost declaration: a reload collects the org's OWN money via Stripe (the org
 * paid its provider) — it is not a metered platform cost, exactly like the
 * authorize / usage_apply reloads. Matches that path's absence of a runs-service
 * cost row.
 */

import crypto from "crypto";
import { and, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { computeBalance } from "./balance.js";
import { tierFor, computeTopupCharge } from "./topup-tier.js";
import { cmpCents } from "./cents.js";
import { coalesceReload } from "./reload-coalescer.js";
import { reloadViaPaymentIntent } from "./reload.js";

// INTERNAL_IDENTITY sentinel — there is no end user on the sweep path. The /v1
// reload primitives (getCustomerByOrg / listPaymentMethods / createPaymentIntent)
// still require x-user-id even though they key on x-org-id, so we pass the
// sentinel exactly like the transfer-brand admin op.
const SWEEP_USER_ID = "00000000-0000-0000-0000-000000000000";

// A hung stripe-service call must not stall the whole sweep loop.
const RELOAD_TIMEOUT_MS = 30_000;

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

/** "YYYY-MM" bucket (UTC) — the idempotency scope for one calendar month. */
export function monthBucket(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Amount-independent, month-scoped Stripe idempotency key. Any two sweep charges
 * for the same org in the same month collapse to one PaymentIntent regardless of
 * the computed amount.
 */
export function sweepIdempotencyKey(orgId: string, bucket: string): string {
  return crypto
    .createHash("sha256")
    .update(`month-end-sweep:${orgId}:${bucket}`)
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
  /** False when `now` is not the last day of the month — the sweep no-ops. */
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
 * Settle every reload-capable org with a negative balance on the last day of the
 * month. Per-org failure is logged and skipped — one unreachable org never blocks
 * the rest (same shape as runDunningTick).
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

  if (!isLastDayOfMonth(now)) return result;
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

      // Force ONE reload of tier-amount multiples toward a target of 0, settling
      // the balance back to >= 0.
      const tier = tierFor(snapshot.paidTopupsCents);
      const chargeAmount = computeTopupCharge(
        snapshot.balanceCents,
        "0",
        tier.amountCents
      );
      if (chargeAmount <= 0) {
        result.skipped += 1;
        continue;
      }

      const identity = {
        "x-org-id": account.orgId,
        "x-user-id": SWEEP_USER_ID,
      };
      const outcome = await coalesceReload(account.orgId, () =>
        withTimeout(
          RELOAD_TIMEOUT_MS,
          reloadViaPaymentIntent(
            identity,
            chargeAmount,
            sweepIdempotencyKey(account.orgId, bucket),
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
