import { describe, it, expect } from "vitest";
import {
  computeSettleCharge,
  isLastDayOfMonth,
  monthBucket,
  STRIPE_MIN_CHARGE_CENTS,
  sweepIdempotencyKey,
} from "../../src/lib/month-end-sweep.js";

// All dates are constructed in UTC (Date.UTC) so the assertions are timezone-
// independent — the sweep gates on the UTC calendar.
function utc(y: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(y, monthIndex, day));
}

describe("isLastDayOfMonth — UTC last-day detection", () => {
  it("31-day month (January): 31 is last, 30 is not", () => {
    expect(isLastDayOfMonth(utc(2026, 0, 31))).toBe(true);
    expect(isLastDayOfMonth(utc(2026, 0, 30))).toBe(false);
  });

  it("30-day month (April): 30 is last, 29 is not", () => {
    expect(isLastDayOfMonth(utc(2026, 3, 30))).toBe(true);
    expect(isLastDayOfMonth(utc(2026, 3, 29))).toBe(false);
  });

  it("28-day February (non-leap 2026): 28 is last", () => {
    expect(isLastDayOfMonth(utc(2026, 1, 28))).toBe(true);
    expect(isLastDayOfMonth(utc(2026, 1, 27))).toBe(false);
  });

  it("29-day February (leap 2024): 29 is last, 28 is NOT", () => {
    expect(isLastDayOfMonth(utc(2024, 1, 29))).toBe(true);
    expect(isLastDayOfMonth(utc(2024, 1, 28))).toBe(false);
  });

  it("December 31 (year rollover) is last", () => {
    expect(isLastDayOfMonth(utc(2026, 11, 31))).toBe(true);
    expect(isLastDayOfMonth(utc(2026, 11, 30))).toBe(false);
  });

  it("time-of-day on the last day does not matter", () => {
    expect(isLastDayOfMonth(new Date(Date.UTC(2026, 0, 31, 23, 59, 59)))).toBe(true);
    expect(isLastDayOfMonth(new Date(Date.UTC(2026, 0, 31, 0, 0, 0)))).toBe(true);
  });
});

describe("monthBucket — YYYY-MM (UTC)", () => {
  it("zero-pads the month", () => {
    expect(monthBucket(utc(2026, 0, 31))).toBe("2026-01");
    expect(monthBucket(utc(2026, 8, 30))).toBe("2026-09");
    expect(monthBucket(utc(2026, 11, 31))).toBe("2026-12");
  });
});

describe("computeSettleCharge — the EXACT deficit, never a tier multiple", () => {
  it("charges exactly the deficit for a whole-cent negative balance", () => {
    expect(computeSettleCharge("-961.0000000000")).toBe(961);
    expect(computeSettleCharge("-2037.9100000000")).toBe(2038);
    expect(computeSettleCharge("-32593.0000000000")).toBe(32593);
    expect(computeSettleCharge("-40924.3800000000")).toBe(40925);
  });

  it("rounds a fractional-cent deficit UP to the whole cent (never under-settles)", () => {
    expect(computeSettleCharge("-1068.9600000000")).toBe(1069);
    expect(computeSettleCharge("-100.0000000001")).toBe(101);
  });

  it("charges nothing when the balance is already non-negative", () => {
    expect(computeSettleCharge("0")).toBe(0);
    expect(computeSettleCharge("0.0000000000")).toBe(0);
    expect(computeSettleCharge("4900.0000000000")).toBe(0);
  });

  it("charges nothing below Stripe's minimum card charge (50 cents)", () => {
    expect(computeSettleCharge("-1.0000000000")).toBe(0);
    expect(computeSettleCharge("-49.0000000000")).toBe(0);
    // 48.5 cents rounds UP to 49, still below the minimum.
    expect(computeSettleCharge("-48.5000000000")).toBe(0);
  });

  it("charges exactly at Stripe's minimum", () => {
    expect(STRIPE_MIN_CHARGE_CENTS).toBe(50);
    expect(computeSettleCharge("-50.0000000000")).toBe(50);
    expect(computeSettleCharge("-51.0000000000")).toBe(51);
    // Rounding up is what carries this one over the minimum.
    expect(computeSettleCharge("-49.9999999999")).toBe(50);
  });

  it("never charges more than the deficit (the overcharge bug)", () => {
    for (const balance of ["-50", "-100", "-961", "-2038", "-32593", "-40925"]) {
      const charge = computeSettleCharge(balance);
      expect(charge).toBe(Math.abs(Number(balance)));
    }
  });
});

describe("sweepIdempotencyKey — stable, month-scoped, 32-hex", () => {
  const org = "00000000-0000-0000-0000-00000000e001";

  it("is deterministic for the same org + bucket", () => {
    expect(sweepIdempotencyKey(org, "2026-01")).toBe(
      sweepIdempotencyKey(org, "2026-01")
    );
  });

  it("differs across months (so a new month can charge again)", () => {
    expect(sweepIdempotencyKey(org, "2026-01")).not.toBe(
      sweepIdempotencyKey(org, "2026-02")
    );
  });

  it("differs across orgs", () => {
    const other = "00000000-0000-0000-0000-00000000e002";
    expect(sweepIdempotencyKey(org, "2026-01")).not.toBe(
      sweepIdempotencyKey(other, "2026-01")
    );
  });

  it("is 32 hex chars", () => {
    expect(sweepIdempotencyKey(org, "2026-01")).toMatch(/^[0-9a-f]{32}$/);
  });
});
