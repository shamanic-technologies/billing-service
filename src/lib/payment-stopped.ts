/**
 * Payment-stopped periods — when an org was not paying.
 *
 * The owner's rule: if payment has stopped (a failed card, credit gone) the org
 * leaves the run-rate, however active its campaigns look. billing is the only
 * service that can answer that, and it already records it: a CREDIT DEPLETION
 * EPISODE opens when the org's balance falls past its credit-line floor and
 * closes when a real recharge lands (`credited` rising — see lib/dunning.ts).
 * That open→recovered pair IS the period, so nothing new is stored here; this
 * reads the existing rows.
 *
 * Two properties of the record a consumer must know, both stated in the
 * response rather than hidden:
 *
 *  - The record is FORWARD-ONLY. `recordBeginsAt` is the earliest episode ever
 *    recorded fleet-wide; before it, billing knows nothing and a day there is
 *    NOT evidence that payment was on.
 *  - An episode opens on an AUTHORIZE that carries campaign activity, so the
 *    period means "payment had stopped while the org was trying to spend". An
 *    org that stopped paying and also stopped working opens no episode.
 *
 * No new state, no new lifecycle: the debt flag (a card we can no longer
 * charge) lives on the SAME episode, so both halves of "payment stopped" are
 * one period already.
 *
 * Fail-loud: any DB error propagates.
 */

import { asc, eq, min } from "drizzle-orm";
import { db } from "../db/index.js";
import { creditDepletionEpisodes } from "../db/schema.js";

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
   * when no episode has ever been recorded. A day before it is NOT RECORDED —
   * the absence of a period there says nothing about whether payment was on.
   *
   * Derived from the data rather than frozen in a constant: it can only move
   * earlier as older rows are the ones that set it, so it cannot go stale, and
   * it never claims coverage we cannot show.
   */
  recordBeginsAt: string | null;
  /** Oldest first. An open period (endedAt null) can only be the last one. */
  periods: PaymentStoppedPeriod[];
}

/**
 * Every payment-stopped period this org has been in, oldest first, with the
 * instant the record itself begins.
 */
export async function getPaymentStoppedPeriods(
  orgId: string
): Promise<PaymentStoppedPeriods> {
  const [[earliest], episodes] = await Promise.all([
    db
      .select({ startedAt: min(creditDepletionEpisodes.startedAt) })
      .from(creditDepletionEpisodes),
    db
      .select({
        startedAt: creditDepletionEpisodes.startedAt,
        recoveredAt: creditDepletionEpisodes.recoveredAt,
      })
      .from(creditDepletionEpisodes)
      .where(eq(creditDepletionEpisodes.orgId, orgId))
      .orderBy(asc(creditDepletionEpisodes.startedAt)),
  ]);

  return {
    recordBeginsAt: earliest?.startedAt
      ? new Date(earliest.startedAt).toISOString()
      : null,
    periods: episodes.map((e) => ({
      startedAt: e.startedAt.toISOString(),
      endedAt: e.recoveredAt ? e.recoveredAt.toISOString() : null,
    })),
  };
}
