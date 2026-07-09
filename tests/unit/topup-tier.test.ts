import { describe, it, expect } from "vitest";
import { tierFor } from "../../src/lib/topup-tier.js";

describe("tierFor — derived postpaid credit-line tiers", () => {
  it("start tier below $200 cumulative paid → $50 line", () => {
    expect(tierFor("0.0000000000")).toEqual({ thresholdCents: -5000, amountCents: 5000 });
    expect(tierFor("0")).toEqual({ thresholdCents: -5000, amountCents: 5000 });
    expect(tierFor("19999.9999999999")).toEqual({ thresholdCents: -5000, amountCents: 5000 });
  });

  it("mid tier at/above $200 cumulative paid → $200 line", () => {
    expect(tierFor("20000")).toEqual({ thresholdCents: -20000, amountCents: 20000 });
    expect(tierFor("20000.0000000000")).toEqual({ thresholdCents: -20000, amountCents: 20000 });
    expect(tierFor("99999.9999999999")).toEqual({ thresholdCents: -20000, amountCents: 20000 });
  });

  it("high tier at/above $1000 cumulative paid → $500 line", () => {
    expect(tierFor("100000")).toEqual({ thresholdCents: -50000, amountCents: 50000 });
    expect(tierFor("100000.0000000000")).toEqual({ thresholdCents: -50000, amountCents: 50000 });
    expect(tierFor("500000")).toEqual({ thresholdCents: -50000, amountCents: 50000 });
  });

  it("every tier: threshold is negative and |threshold| equals amount", () => {
    for (const paid of ["0", "20000", "100000", "1000000"]) {
      const tier = tierFor(paid);
      expect(tier.thresholdCents).toBeLessThan(0);
      expect(Math.abs(tier.thresholdCents)).toBe(tier.amountCents);
    }
  });

  it("breakpoints are inclusive at the lower edge, exclusive one cent below", () => {
    expect(tierFor("19999").amountCents).toBe(5000);
    expect(tierFor("20000").amountCents).toBe(20000);
    expect(tierFor("99999").amountCents).toBe(20000);
    expect(tierFor("100000").amountCents).toBe(50000);
  });
});
