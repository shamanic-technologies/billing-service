import { describe, it, expect } from "vitest";
import {
  currentUtcDay,
  enumerateUtcDays,
  formatUtcDay,
  parseUtcDay,
  utcDayEndExclusive,
  utcDaySpan,
} from "../../src/lib/utc-day.js";

describe("UTC day helpers", () => {
  it("parses a strict YYYY-MM-DD to that day's UTC midnight", () => {
    expect(parseUtcDay("2026-08-14")?.toISOString()).toBe("2026-08-14T00:00:00.000Z");
  });

  it("rejects a well-formed but impossible date instead of rolling it forward", () => {
    // new Date("2026-02-31") silently yields March 3rd — answering about the
    // wrong day is worse than refusing.
    expect(parseUtcDay("2026-02-31")).toBeNull();
    expect(parseUtcDay("2026-13-01")).toBeNull();
  });

  it("rejects anything that is not exactly YYYY-MM-DD", () => {
    for (const bad of [
      "2026-8-14",
      "2026/08/14",
      "14-08-2026",
      "2026-08-14T00:00:00Z",
      "",
      "today",
    ]) {
      expect(parseUtcDay(bad)).toBeNull();
    }
  });

  it("accepts a leap day in a leap year and refuses it otherwise", () => {
    expect(parseUtcDay("2028-02-29")?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(parseUtcDay("2026-02-29")).toBeNull();
  });

  it("a day ends at the next day's 00:00:00.000Z", () => {
    const start = parseUtcDay("2026-08-14")!;
    expect(utcDayEndExclusive(start).toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });

  it("spans are inclusive on both ends", () => {
    expect(utcDaySpan(parseUtcDay("2026-08-14")!, parseUtcDay("2026-08-14")!)).toBe(1);
    expect(utcDaySpan(parseUtcDay("2026-08-01")!, parseUtcDay("2026-08-31")!)).toBe(31);
  });

  it("enumerates every day of a range, oldest first, across a month boundary", () => {
    const days = enumerateUtcDays(parseUtcDay("2026-08-30")!, parseUtcDay("2026-09-02")!);
    expect(days.map(formatUtcDay)).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });

  it("currentUtcDay is the UTC midnight of the instant's own calendar day", () => {
    expect(currentUtcDay(new Date("2026-08-14T23:59:59.999Z")).toISOString()).toBe(
      "2026-08-14T00:00:00.000Z"
    );
    expect(currentUtcDay(new Date("2026-08-15T00:00:00.000Z")).toISOString()).toBe(
      "2026-08-15T00:00:00.000Z"
    );
  });
});
