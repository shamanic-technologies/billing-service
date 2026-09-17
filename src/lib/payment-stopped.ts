/**
 * Payment-stopped periods — when an org was not paying.
 *
 * The owner's rule: if payment has stopped (a failed card, credit gone) the org
 * leaves the run-rate, however active its campaigns look. billing is the only
 * service that can answer that, and it already records BOTH halves.
 *
 * TWO SOURCES, and the second one is why this file exists.
 *
 *  - CREDIT GONE is a credit-depletion episode (lib/dunning): it opens when the
 *    balance falls past the org's credit-line floor and closes when a real
 *    recharge lands. That open→recovered pair IS a period.
 *  - A FAILED CARD is an OPEN FAILED RELOAD STREAK
 *    (`campaign_reload_sweep_attempts`, lib/campaign-reload-sweep): the bank
 *    refused, and the spaced retry schedule is still walking its rungs.
 *
 * This read used to serve only the first, while documenting both — so an org
 * whose card the bank refused this morning, blocked from every run, answered
 * `periods: []`. Prod 2026-09-17, org 81b34252-…: a declined $50 charge, 82
 * consecutive BLOCKED gate checks, and ZERO episodes ever, because its balance
 * sat INSIDE its credit-line floor the whole time (−4994.13 against −5000) and
 * `isDepleted` is false there. features-service read `paymentActive: true` and
 * the staff console counted $1,470/month of MRR from a refused card.
 *
 * Nothing new is stored. No episode is opened, no dunning fires, no charge,
 * retry or backoff behaviour changes — this is a READ over rows both mechanisms
 * already write.
 *
 * WHAT THE FAILED-STREAK SOURCE CAN AND CANNOT SAY. The attempts table holds
 * ONE row per org, overwritten in place, with no `recovered_at` — a streak is
 * ended by being replaced, not by being closed. So only the OPEN streak is
 * expressible and PAST streaks are unrecorded. That is stated here rather than
 * reconstructed: inventing a closed history we never wrote would be worse than
 * admitting we did not write it.
 *
 * WHEN A STREAK IS OVER, and why that needs a credited read. A succeeded reload
 * rewrites the row (`last_outcome: "succeeded"`, anchor cleared). A RECHARGE
 * does not touch the row at all — the org simply stops being blocked, so the
 * sweep skips it before it ever records anything, and the stale `failed` row
 * would otherwise report that org as payment-stopped FOREVER. `credited` rising
 * is exactly how lib/campaign-reload-sweep and lib/card-usability decide the
 * streak is over, so this read makes the SAME comparison rather than inventing
 * a second rule. It is the one external read here, and it happens ONLY for an
 * org that actually carries a failed row — every other org's response costs
 * exactly what it cost before.
 *
 * Two properties of the record a consumer must know, both stated in the
 * response rather than hidden:
 *
 *  - The record is FORWARD-ONLY. `recordBeginsAt` is the earliest instant
 *    EITHER source recorded anything, fleet-wide; before it, billing knows
 *    nothing and a day there is NOT evidence that payment was on.
 *  - An episode opens on an AUTHORIZE that carries campaign activity, so that
 *    kind of period means "payment had stopped while the org was trying to
 *    spend". An org that stopped paying and also stopped working opens none —
 *    which is precisely the gap the failed-streak source closes.
 *
 * Fail-loud: any DB or stripe-service error propagates (the route answers 502).
 */

import { asc, eq, min } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaignReloadSweepAttempts, creditDepletionEpisodes } from "../db/schema.js";
import { composeCreditedCents } from "./balance.js";
import { cmpCents } from "./cents.js";

/** One stretch of time during which the org's payment had stopped. */
export interface PaymentStoppedPeriod {
  /** When it began (ISO 8601). */
  startedAt: string;
  /** When it ended (ISO 8601), or null while the org is still in it. */
  endedAt: string | null;
}

export interface PaymentStoppedPeriods {
  /**
   * The earliest instant this record demonstrably exists (ISO 8601), or null
   * when nothing has ever been recorded. A day before it is NOT RECORDED —
   * the absence of a period there is not evidence that payment was on.
   *
   * Derived from the data rather than frozen in a constant, and it is the
   * earliest across BOTH sources: an instant either mechanism has already
   * written is an instant we can speak about. It can therefore only ever move
   * earlier as older rows arrive, so it cannot go stale, and it never claims
   * coverage we cannot show. (The failed-streak source is far younger than the
   * episode one, so in practice the episodes still set it.)
   */
  recordBeginsAt: string | null;
  /**
   * Oldest first, and DISJOINT — overlapping stretches from the two sources are
   * merged, so the same day is never described twice and an open period
   * (endedAt null) can only be the last one.
   */
  periods: PaymentStoppedPeriod[];
}

interface Interval {
  startedAt: Date;
  /** Null = still open. */
  endedAt: Date | null;
}

/**
 * Merge overlapping stretches into one.
 *
 * An org can carry an open episode AND an open failed streak at once — two
 * descriptions of one ongoing stretch — and emitting both would be nonsense
 * even though the consumer's only question ("is day X inside any period") would
 * survive it. The union answers that question identically while keeping the
 * response coherent: disjoint, oldest first, at most one open period, last.
 */
function unionIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime()
  );
  const merged: Interval[] = [];
  for (const next of sorted) {
    const current = merged[merged.length - 1];
    // An open period swallows everything that starts at or after its start.
    const touches =
      current !== undefined &&
      (current.endedAt === null ||
        current.endedAt.getTime() >= next.startedAt.getTime());
    if (!touches) {
      merged.push({ ...next });
      continue;
    }
    if (current.endedAt === null) continue;
    current.endedAt =
      next.endedAt === null
        ? null
        : new Date(Math.max(current.endedAt.getTime(), next.endedAt.getTime()));
  }
  return merged;
}

/**
 * The org's OPEN failed-reload streak, if it is still open.
 *
 * Open means: the last attempt FAILED, it left an anchor, and the world has not
 * moved since (`credited` unchanged — the same test decideAttempt and
 * isCardUnusableFor make). A permanently-unusable card is included rather than
 * special-cased: that org's payment has stopped harder, not less.
 */
async function openFailedReloadStreak(orgId: string): Promise<Interval | null> {
  const [row] = await db
    .select()
    .from(campaignReloadSweepAttempts)
    .where(eq(campaignReloadSweepAttempts.orgId, orgId))
    .limit(1);

  if (!row) return null;
  if (row.lastOutcome !== "failed") return null;
  if (row.firstFailedAt == null) return null;

  const { creditedCents } = await composeCreditedCents(orgId);
  if (cmpCents(row.creditedCentsAtAttempt, creditedCents) !== 0) return null;

  return { startedAt: row.firstFailedAt, endedAt: null };
}

/**
 * Every payment-stopped period this org has been in, oldest first, with the
 * instant the record itself begins.
 */
export async function getPaymentStoppedPeriods(
  orgId: string
): Promise<PaymentStoppedPeriods> {
  const [[earliestEpisode], [earliestStreak], episodes, streak] = await Promise.all([
    db
      .select({ startedAt: min(creditDepletionEpisodes.startedAt) })
      .from(creditDepletionEpisodes),
    db
      .select({ firstFailedAt: min(campaignReloadSweepAttempts.firstFailedAt) })
      .from(campaignReloadSweepAttempts),
    db
      .select({
        startedAt: creditDepletionEpisodes.startedAt,
        recoveredAt: creditDepletionEpisodes.recoveredAt,
      })
      .from(creditDepletionEpisodes)
      .where(eq(creditDepletionEpisodes.orgId, orgId))
      .orderBy(asc(creditDepletionEpisodes.startedAt)),
    openFailedReloadStreak(orgId),
  ]);

  const beginnings = [earliestEpisode?.startedAt, earliestStreak?.firstFailedAt]
    .filter((d): d is Date => d != null)
    .map((d) => new Date(d).getTime());

  const intervals: Interval[] = episodes.map((e) => ({
    startedAt: e.startedAt,
    endedAt: e.recoveredAt,
  }));
  if (streak) intervals.push(streak);

  return {
    recordBeginsAt:
      beginnings.length > 0 ? new Date(Math.min(...beginnings)).toISOString() : null,
    periods: unionIntervals(intervals).map((i) => ({
      startedAt: i.startedAt.toISOString(),
      endedAt: i.endedAt ? i.endedAt.toISOString() : null,
    })),
  };
}
