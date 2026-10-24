/**
 * Credit events — "credit ran out" / "credit restored", as a dated feed.
 *
 * Owner 2026-10-24 (CREDIT-RAN-OUT-UNIBOX-EVENT-1024): when a client's credit
 * runs out, that fact shows on the timeline of the client's people in the
 * distribute.you staff Unibox, like a reply or a visit, and counts as a Lead
 * event — so the generic reactive campaign ("each Unibox event of a current
 * client") fires on it. No credit-specific trigger (owner: « non »), and the
 * dunning emails are untouched (« ça n'annule pas le transactionnel »).
 *
 * billing already RECORDS the fact: a credit-depletion episode opens when the
 * org runs out (lib/dunning, lib/spend-block) and closes when a real recharge
 * lands (`credited` rising). This file only REPLAYS those rows as events for
 * crm-service (the fact registry) to pull. Nothing new is stored, no episode
 * is opened or closed here, and no dunning send changes.
 *
 * WHY A PULL FEED, not a push: a missed push loses a fact forever, and the
 * backfill (episodes already open today) would need its own one-off path. A
 * cursor over the episode rows answers both with one read.
 *
 * Contract:
 *  - one `credit_ran_out` per episode, `at` = `started_at`;
 *  - one `credit_restored` per CLOSED episode, `at` = `recovered_at`;
 *  - `eventId` = `<episodeId>:ran_out` | `<episodeId>:restored`, stable forever,
 *    the consumer's idempotency key;
 *  - total order (at, eventId); the cursor is opaque and carries `at` at
 *    MICROSECOND precision (a JS Date would round it and re-serve or skip a row);
 *  - only events at least `SETTLE_MS` old are served, so a row committed a
 *    moment after a later-stamped one is never jumped by a cursor;
 *  - who the person is behind `orgId` is the consumer's to resolve. Platform
 *    orgs never open an episode; staff/test orgs are NOT filtered here (the
 *    registry's own staff rules apply, exactly as for every other source).
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

export const CREDIT_EVENT_TYPES = ["credit_ran_out", "credit_restored"] as const;
export type CreditEventType = (typeof CREDIT_EVENT_TYPES)[number];

export interface CreditEvent {
  eventId: string;
  type: CreditEventType;
  orgId: string;
  episodeId: string;
  at: string;
}

export const CREDIT_EVENTS_DEFAULT_LIMIT = 500;
export const CREDIT_EVENTS_MAX_LIMIT = 1000;
export const CREDIT_EVENTS_SETTLE_MS = 60_000;

interface Cursor {
  at: string;
  id: string;
}

export class InvalidCreditEventsCursorError extends Error {}

export function encodeCreditEventsCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCreditEventsCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCreditEventsCursorError("cursor is not a valid credit-events cursor");
  }
  const c = parsed as Partial<Cursor> | null;
  if (
    !c ||
    typeof c.at !== "string" ||
    typeof c.id !== "string" ||
    Number.isNaN(Date.parse(c.at))
  ) {
    throw new InvalidCreditEventsCursorError("cursor is not a valid credit-events cursor");
  }
  return { at: c.at, id: c.id };
}

export async function listCreditEvents(params: {
  cursor: string | null;
  limit: number;
  now?: Date;
}): Promise<{ events: CreditEvent[]; nextCursor: string | null; hasMore: boolean }> {
  const after = params.cursor ? decodeCreditEventsCursor(params.cursor) : null;
  const settledBefore = new Date(
    (params.now ?? new Date()).getTime() - CREDIT_EVENTS_SETTLE_MS
  ).toISOString();

  // `at_text` keeps microseconds for the cursor; `at_iso` is the served value.
  const rows = await db.execute<{
    event_id: string;
    type: CreditEventType;
    org_id: string;
    episode_id: string;
    at_text: string;
    at_iso: string;
  }>(sql`
    WITH ev AS (
      SELECT id::text || ':ran_out' AS event_id, 'credit_ran_out' AS type,
             org_id::text AS org_id, id::text AS episode_id, started_at AS at
        FROM credit_depletion_episodes
      UNION ALL
      SELECT id::text || ':restored', 'credit_restored',
             org_id::text, id::text, recovered_at
        FROM credit_depletion_episodes
       WHERE recovered_at IS NOT NULL
    )
    SELECT event_id, type, org_id, episode_id,
           to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_text,
           to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at_iso
      FROM ev
     WHERE at <= ${settledBefore}::timestamptz
       ${
         after
           ? sql`AND (at, event_id) > (${after.at}::timestamptz, ${after.id})`
           : sql``
       }
     ORDER BY at, event_id
     LIMIT ${params.limit + 1}
  `);

  const list = [...rows];
  const hasMore = list.length > params.limit;
  const page = hasMore ? list.slice(0, params.limit) : list;
  const last = page[page.length - 1];
  return {
    events: page.map((r) => ({
      eventId: r.event_id,
      type: r.type,
      orgId: r.org_id,
      episodeId: r.episode_id,
      at: r.at_iso,
    })),
    // Even on the last page the cursor advances, so the next poll starts
    // after what was just read. Null only when nothing was ever served.
    nextCursor: last
      ? encodeCreditEventsCursor({ at: last.at_text, id: last.event_id })
      : params.cursor,
    hasMore,
  };
}
