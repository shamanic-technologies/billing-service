/**
 * UTC calendar-day helpers for the past-day reads.
 *
 * Everything billing records is a timestamptz; a consumer asking "what was true
 * on 2026-08-14" is asking about the UTC day [00:00Z, next 00:00Z). These
 * helpers are the ONE place that boundary is computed, so the budget read and
 * any later day-keyed read cannot disagree about where a day ends.
 *
 * Fail-loud: a malformed date returns null and the caller writes the 400 — no
 * silent coercion, no "close enough" parse (`new Date("2026-02-31")` happily
 * yields March 3rd, which would silently answer about the wrong day).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const MAX_DAY_RANGE_DAYS = 366;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Parse a strict `YYYY-MM-DD` into the UTC midnight that STARTS that day.
 * Returns null on anything else, including a well-formed-but-impossible date
 * (`2026-02-31`) — the round-trip check is what rejects those.
 */
export function parseUtcDay(value: string): Date | null {
  if (!DATE_RE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Round-trip: rejects 2026-02-31 (which JS rolls forward to March 3rd).
  if (formatUtcDay(parsed) !== value) return null;
  return parsed;
}

/** Render a Date as the `YYYY-MM-DD` of its UTC calendar day. */
export function formatUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The exclusive upper bound of a UTC day: the next day's 00:00:00.000Z. */
export function utcDayEndExclusive(dayStart: Date): Date {
  return new Date(dayStart.getTime() + MS_PER_DAY);
}

/** The UTC calendar day `now` falls in, as a 00:00:00.000Z Date. */
export function currentUtcDay(now: Date = new Date()): Date {
  return new Date(`${formatUtcDay(now)}T00:00:00.000Z`);
}

/** Inclusive count of UTC days from `from` to `to` (same day → 1). */
export function utcDaySpan(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY) + 1;
}

/** Every UTC calendar day from `from` to `to`, inclusive, oldest first. */
export function enumerateUtcDays(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += MS_PER_DAY) {
    days.push(new Date(t));
  }
  return days;
}
