/**
 * The gap between two predicates that decided one thing and did not agree.
 *
 * Anchored on the prod geometry measured 2026-09-17 for org 81b34252-…: balance
 * −4994.1310968628 cents against a −5000 credit-line floor with an 11.80-cent
 * stored estimate — 5.87 cents of headroom for a run needing 11.80. Every run
 * refused, so the balance never moved, so it never crossed the floor, so the old
 * `balance <= floor` gate never opened an episode. 41 hours, 83 refusals, zero
 * episodes ever.
 */
import { describe, it, expect } from "vitest";
import { cannotSpend } from "../../src/lib/spend-block.js";

const FLOOR = "-5000";
const ESTIMATE = "11.8000000000";

describe("cannotSpend", () => {
  it("is TRUE inside the gap band — the 5.87 cents that wedged the prod org", () => {
    // Above the floor by 5.87, which is LESS than the 11.80 the next run needs.
    expect(cannotSpend("-4994.1310968628", ESTIMATE, FLOOR)).toBe(true);
  });

  it("is FALSE for a postpaid org running negative WITHIN its credit line", () => {
    // −4000 leaves 1000 cents of headroom for an 11.80-cent run: it can spend,
    // and it must never be dunned. The old tick gate compared this against a
    // hardcoded "0" and called it depleted.
    expect(cannotSpend("-4000", ESTIMATE, FLOOR)).toBe(false);
  });

  it("is TRUE exactly on the floor, whatever the estimate", () => {
    // A balance sitting ON the floor is not spendable — the subtraction alone
    // would read it as fine when the estimate is 0.
    expect(cannotSpend("-5000", "0", FLOOR)).toBe(true);
    expect(cannotSpend("-5000", ESTIMATE, FLOOR)).toBe(true);
  });

  it("is FALSE one cent above the floor when nothing is queued", () => {
    expect(cannotSpend("-4999", "0", FLOOR)).toBe(false);
  });

  it("reduces to the legacy check when no estimate is stored", () => {
    // required "0" ⇒ exactly `balance <= floor`, so an org with no campaign
    // history behaves precisely as it always did.
    expect(cannotSpend("0", "0", "0")).toBe(true);
    expect(cannotSpend("-1", "0", "0")).toBe(true);
    expect(cannotSpend("0.0000000001", "0", "0")).toBe(false);
  });

  it("is TRUE for a PREPAID org holding less than its next run costs", () => {
    // 5 cents of real credit, an 11.80-cent run, floor "0": positive balance,
    // and it still cannot spend. 92 of 112 prod accounts carry no topup config.
    expect(cannotSpend("5", ESTIMATE, "0")).toBe(true);
    expect(cannotSpend("50", ESTIMATE, "0")).toBe(false);
  });

  it("boundary: exactly enough for the next run is spendable", () => {
    expect(cannotSpend("-4988.2000000000", ESTIMATE, FLOOR)).toBe(false);
    expect(cannotSpend("-4988.2000000001", ESTIMATE, FLOOR)).toBe(true);
  });
});
