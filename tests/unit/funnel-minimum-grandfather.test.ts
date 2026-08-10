import { describe, it, expect } from "vitest";
import {
  assertFundedFunnelMeetsMinimum,
  FunnelBudgetBelowMinimumError,
  BRAND_FUNNEL_MIN_DAILY_BUDGET_CENTS,
} from "../../src/lib/brand-funnel-budgets.js";

/**
 * The product minimum governs what a customer may NEWLY STATE, not what one has
 * already been running. A ceiling that predates the minimum (carried over
 * verbatim by the single-funnel attribution sweep) may be kept or raised; it may
 * not be lowered to another funded sub-minimum value.
 */
describe("funded-funnel minimum, grandfathered by the stored ceiling", () => {
  const min = BRAND_FUNNEL_MIN_DAILY_BUDGET_CENTS.reply_meeting; // 2400

  const assert = (value: number, stored: number | null) =>
    assertFundedFunnelMeetsMinimum(
      "reply_meeting",
      String(value),
      stored === null ? null : String(stored)
    );

  // --- AC1: no stored ceiling, or one at/above the minimum: unchanged ---

  it("refuses a funded sub-minimum value when the funnel has NO stored ceiling", () => {
    expect(() => assert(800, null)).toThrow(FunnelBudgetBelowMinimumError);
    expect(() => assert(800, null)).toThrow(/needs at least \$24\/day/);
  });

  it("refuses a funded sub-minimum value when the stored ceiling is zero", () => {
    // Zero is "not funding this funnel", not a grandfathered amount.
    expect(() => assert(800, 0)).toThrow(FunnelBudgetBelowMinimumError);
  });

  it("accepts any value at or above the minimum", () => {
    expect(() => assert(min, null)).not.toThrow();
    expect(() => assert(min + 100, null)).not.toThrow();
    expect(() => assert(min, 800)).not.toThrow();
  });

  it("accepts zero from any state — defunding is never blocked", () => {
    expect(() => assert(0, null)).not.toThrow();
    expect(() => assert(0, 800)).not.toThrow();
    expect(() => assert(0, min)).not.toThrow();
  });

  // --- AC2: stored above zero and below the minimum is grandfathered ---

  it("accepts re-stating the same grandfathered value", () => {
    expect(() => assert(800, 800)).not.toThrow();
  });

  it("accepts raising it to a higher value that is still below the minimum", () => {
    expect(() => assert(1000, 800)).not.toThrow();
  });

  it("accepts raising it past the minimum", () => {
    expect(() => assert(3000, 800)).not.toThrow();
  });

  it("accepts setting a grandfathered funnel to zero", () => {
    expect(() => assert(0, 800)).not.toThrow();
  });

  it("REFUSES lowering it to another funded sub-minimum value", () => {
    expect(() => assert(500, 800)).toThrow(FunnelBudgetBelowMinimumError);
  });

  it("refuses lowering by a fraction of a cent", () => {
    expect(() =>
      assertFundedFunnelMeetsMinimum("reply_meeting", "799.9999999999", "800")
    ).toThrow(FunnelBudgetBelowMinimumError);
  });

  it("the refusal says what the customer CAN do, not only the minimum", () => {
    let message = "";
    try {
      assert(500, 800);
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message).toContain("Sales Meeting (reply)");
    expect(message).toContain("keep it at $8/day");
    expect(message).toContain("raise it");
    expect(message).toContain("set it to 0");
    expect(message).toContain("$5/day"); // what they actually sent
  });

  // --- AC3: the grandfather is spent once the ceiling reaches the minimum ---

  it("once the ceiling reaches the minimum, a later sub-minimum write is refused", () => {
    // The customer raised 800 -> 2400 (allowed above). From there the stored
    // ceiling is no longer sub-minimum, so it falls back to the ordinary rule.
    expect(() => assert(min, 800)).not.toThrow();
    expect(() => assert(800, min)).toThrow(FunnelBudgetBelowMinimumError);
    expect(() => assert(800, min)).toThrow(/needs at least \$24\/day/);
  });

  it("a ceiling above the minimum grants no licence either", () => {
    expect(() => assert(800, 5000)).toThrow(FunnelBudgetBelowMinimumError);
  });

  // --- Each funnel carries its own minimum ---

  it("applies the Website Purchase minimum to that funnel", () => {
    expect(() =>
      assertFundedFunnelMeetsMinimum("visit_signup", "50", null)
    ).toThrow(/\$1\/day/);
    expect(() =>
      assertFundedFunnelMeetsMinimum("visit_signup", "60", "50")
    ).not.toThrow();
  });
});
