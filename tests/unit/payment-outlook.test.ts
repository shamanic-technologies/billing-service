/**
 * The dating arithmetic behind "when will this org next be charged".
 *
 * Every fixture here is a real production geometry measured on 2026-09-18 over
 * the twelve orgs that had spent anything in the preceding fortnight — because
 * the three decisions this module makes were all made AGAINST the obvious
 * design, by that measurement:
 *
 *   - half those orgs carry no auto-topup, so the honest answer for them is a
 *     state with no date rather than a date;
 *   - the two orgs already past their floor are exactly the two whose card the
 *     bank is refusing, so a date is about an ATTEMPT, not a payment;
 *   - utilisation of the configured ceiling ran 4% to 146%, so the ceiling
 *     cannot stand in for the realized burn in either direction.
 */
import { describe, it, expect } from "vitest";
import {
  floorCrossingAt,
  nextMonthEndSweepAt,
  settlesAtMonthEnd,
} from "../../src/lib/payment-outlook.js";
import { nextRetryDueAt } from "../../src/lib/campaign-reload-sweep.js";
import { SWEEP_HOUR_UTC } from "../../src/lib/month-end-sweep.js";
import { burnWindowStart, BURN_WINDOW_DAYS } from "../../src/lib/realized-burn.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-18T12:00:00.000Z");

describe("floorCrossingAt", () => {
  it("dates the crossing for org 5fefaf5a — $8.32/day against $52.19 of headroom", () => {
    // Prod: balance −14780.58 against a −20000 floor, burning 832.30 cents/day,
    // with no stored estimate. 5219.42 / 832.30 = 6.27 days.
    const at = floorCrossingAt("-14780.5804131471", "-20000", "0", "832.3021428571", NOW);
    expect(at).not.toBeNull();
    const days = (at!.getTime() - NOW.getTime()) / DAY_MS;
    expect(days).toBeCloseTo(6.27, 1);
  });

  it("RESERVES the next run's estimate — the charge fires before the bare floor", () => {
    // This is the whole of org 81b34252's geometry: −4995.78 against a −5000
    // floor is 4.22 cents ABOVE the floor, so a bare-floor date says "3 minutes
    // away" — but its stored estimate is 11.80, so `balance − required` is
    // ALREADY under the floor and the charge is due now, not later. Dating the
    // bare floor is late by exactly `required / burn`.
    expect(
      floorCrossingAt("-4995.7810968628", "-5000", "11.8000000000", "1965.0557142857", NOW)
    ).toBeNull();
    // Without the estimate the same balance reads as still having headroom —
    // which is the wrong answer, and the reason the estimate is a parameter.
    expect(
      floorCrossingAt("-4995.7810968628", "-5000", "0", "1965.0557142857", NOW)
    ).not.toBeNull();
  });

  it("is null exactly ON the floor", () => {
    expect(floorCrossingAt("-5000", "-5000", "0", "100", NOW)).toBeNull();
  });

  it("is null when nothing is burning — a rate of zero never crosses anything", () => {
    expect(floorCrossingAt("5000", "-5000", "0", "0", NOW)).toBeNull();
    expect(floorCrossingAt("5000", "-5000", "0", "-1", NOW)).toBeNull();
  });

  it("uses the FLOOR, not zero — a postpaid org may spend its whole credit line", () => {
    // A positive balance of 1000 with a −5000 floor has 6000 of headroom, not
    // 1000: dating it at zero would predict a charge five days too early.
    const at = floorCrossingAt("1000", "-5000", "0", "1000", NOW);
    expect((at!.getTime() - NOW.getTime()) / DAY_MS).toBeCloseTo(6, 6);
  });

  it("keeps fractional-cent precision rather than rounding through a float", () => {
    const at = floorCrossingAt("0.0000000010", "0", "0", "0.0000000001", NOW);
    expect((at!.getTime() - NOW.getTime()) / DAY_MS).toBeCloseTo(10, 6);
  });
});

describe("settlesAtMonthEnd", () => {
  const monthEnd = new Date("2026-09-30T23:00:00.000Z");

  it("is TRUE for a balance already negative, whatever the rate", () => {
    // The sweep settles what is owed; an org in the red on the day owes.
    expect(settlesAtMonthEnd("-1066", "0", NOW, monthEnd)).toBe(true);
  });

  it("is TRUE when spend carries a positive balance below zero first", () => {
    // 1000 cents of credit burning 100/day, twelve days out: −200 by the sweep.
    expect(settlesAtMonthEnd("1000", "100", NOW, monthEnd)).toBe(true);
  });

  it("is FALSE for an org that will still hold credit on the day", () => {
    // This is the case that matters: treating month-end as an unconditional
    // charge would promise one to every org holding credit, which is most.
    expect(settlesAtMonthEnd("100000", "100", NOW, monthEnd)).toBe(false);
  });

  it("is FALSE for a non-negative balance that is not burning at all", () => {
    expect(settlesAtMonthEnd("0", "0", NOW, monthEnd)).toBe(false);
  });
});

describe("nextMonthEndSweepAt", () => {
  it("lands on the last day of the month at the sweep HOUR, not midnight", () => {
    // The hour is part of the sweep's own gate for a documented reason (a
    // day-only gate re-charged an org on every remaining tick of the day), so
    // it is part of the date.
    const at = nextMonthEndSweepAt(NOW);
    expect(at.toISOString()).toBe(
      `2026-09-30T${String(SWEEP_HOUR_UTC).padStart(2, "0")}:00:00.000Z`
    );
  });

  it("rolls to NEXT month once this month's sweep hour has passed", () => {
    const after = new Date("2026-09-30T23:30:00.000Z");
    expect(nextMonthEndSweepAt(after).toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });

  it("still returns today's sweep while it is only minutes away", () => {
    const before = new Date("2026-09-30T22:59:00.000Z");
    expect(nextMonthEndSweepAt(before).toISOString()).toBe("2026-09-30T23:00:00.000Z");
  });

  it("handles a February and a leap February", () => {
    expect(nextMonthEndSweepAt(new Date("2026-02-10T00:00:00Z")).toISOString()).toBe(
      "2026-02-28T23:00:00.000Z"
    );
    expect(nextMonthEndSweepAt(new Date("2028-02-10T00:00:00Z")).toISOString()).toBe(
      "2028-02-29T23:00:00.000Z"
    );
  });

  it("rolls across a year boundary", () => {
    expect(nextMonthEndSweepAt(new Date("2026-12-31T23:30:00Z")).toISOString()).toBe(
      "2027-01-31T23:00:00.000Z"
    );
  });
});

describe("nextRetryDueAt — the refused-card schedule, shared with the sweep", () => {
  const anchor = new Date("2026-09-17T06:47:44.000Z"); // org 81b34252's first refusal

  it("walks 1d, 3d, 7d, 14d from the streak's FIRST refusal", () => {
    // Anchored on the first rather than the last refusal, so a deploy or a
    // missed tick cannot shift every later rung.
    expect(nextRetryDueAt(1, anchor)!.toISOString()).toBe("2026-09-18T06:47:44.000Z");
    expect(nextRetryDueAt(2, anchor)!.toISOString()).toBe("2026-09-20T06:47:44.000Z");
    expect(nextRetryDueAt(3, anchor)!.toISOString()).toBe("2026-09-24T06:47:44.000Z");
    expect(nextRetryDueAt(4, anchor)!.toISOString()).toBe("2026-10-01T06:47:44.000Z");
  });

  it("is null past the last rung — five refusals over a fortnight is an answer", () => {
    expect(nextRetryDueAt(5, anchor)).toBeNull();
    expect(nextRetryDueAt(9, anchor)).toBeNull();
  });
});

describe("burnWindowStart", () => {
  it("opens the window exactly BURN_WINDOW_DAYS back", () => {
    expect(burnWindowStart(NOW)).toBe("2026-09-04T12:00:00.000Z");
    expect(BURN_WINDOW_DAYS).toBe(14);
  });
});
