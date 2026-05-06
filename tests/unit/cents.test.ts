import { describe, it, expect } from "vitest";
import {
  parsePositiveCents,
  parseNonNegativeCents,
  addCents,
  subCents,
  cmpCents,
  isDepleted,
  gte,
  ceilToInt,
  stripeCeilDelta,
} from "../../src/lib/cents.js";

describe("parsePositiveCents — input validation", () => {
  it("accepts decimal string", () => {
    expect(parsePositiveCents("0.42")).toBe("0.4200000000");
  });

  it("accepts decimal number", () => {
    expect(parsePositiveCents(0.42)).toBe("0.4200000000");
  });

  it("accepts integer", () => {
    expect(parsePositiveCents(100)).toBe("100.0000000000");
    expect(parsePositiveCents("100")).toBe("100.0000000000");
  });

  it("preserves sub-cent precision", () => {
    expect(parsePositiveCents("0.0000000001")).toBe("0.0000000001");
    expect(parsePositiveCents("1.234567")).toBe("1.2345670000");
  });

  it("rejects negative number", () => {
    expect(() => parsePositiveCents(-1)).toThrow();
    expect(() => parsePositiveCents("-0.5")).toThrow();
  });

  it("rejects zero", () => {
    expect(() => parsePositiveCents(0)).toThrow();
    expect(() => parsePositiveCents("0")).toThrow();
  });

  it("rejects NaN / Infinity", () => {
    expect(() => parsePositiveCents(NaN)).toThrow();
    expect(() => parsePositiveCents(Infinity)).toThrow();
    expect(() => parsePositiveCents(-Infinity)).toThrow();
  });

  it("rejects non-numeric string", () => {
    expect(() => parsePositiveCents("abc")).toThrow();
    expect(() => parsePositiveCents("1.2.3")).toThrow();
  });

  it("rejects integer part > 16 digits", () => {
    expect(() => parsePositiveCents("99999999999999999")).toThrow(); // 17 digits
  });

  it("accepts integer part of exactly 16 digits", () => {
    expect(parsePositiveCents("9999999999999999")).toBe("9999999999999999.0000000000");
  });

  it("rejects null/undefined/objects", () => {
    expect(() => parsePositiveCents(null)).toThrow();
    expect(() => parsePositiveCents(undefined)).toThrow();
    expect(() => parsePositiveCents({})).toThrow();
    expect(() => parsePositiveCents([])).toThrow();
  });
});

describe("parseNonNegativeCents — allows zero", () => {
  it("accepts zero", () => {
    expect(parseNonNegativeCents(0)).toBe("0.0000000000");
  });

  it("rejects negative", () => {
    expect(() => parseNonNegativeCents(-0.0001)).toThrow();
  });
});

describe("addCents / subCents / cmpCents", () => {
  it("preserves sub-cent precision under addition", () => {
    let bal = "5.7531000000";
    for (let i = 0; i < 100; i++) bal = subCents(bal, "0.0001");
    expect(bal).toBe("5.7431000000");
  });

  it("mixed adds and subs preserve exact math", () => {
    // 5.7531 - 10*0.0001 - 10*0.4 = 5.7531 - 0.001 - 4 = 1.7521
    let bal = "5.7531000000";
    for (let i = 0; i < 10; i++) bal = subCents(bal, "0.0001");
    for (let i = 0; i < 10; i++) bal = subCents(bal, "0.4");
    expect(bal).toBe("1.7521000000");
  });

  it("compares correctly", () => {
    expect(cmpCents("1.5", "1.5")).toBe(0);
    expect(cmpCents("1.5", "1.50000")).toBe(0);
    expect(cmpCents("1.5", "1.4")).toBe(1);
    expect(cmpCents("1.5", "1.6")).toBe(-1);
  });

  it("isDepleted true for ≤ 0", () => {
    expect(isDepleted("0")).toBe(true);
    expect(isDepleted("-0.0001")).toBe(true);
    expect(isDepleted("0.0000000001")).toBe(false);
  });

  it("gte handles fractions", () => {
    expect(gte("100.0001", "100")).toBe(true);
    expect(gte("100", "100.0001")).toBe(false);
    expect(gte("100", "100")).toBe(true);
  });
});

describe("stripeCeilDelta — Stripe sync sizing", () => {
  it("returns 0 when no ceil-cent boundary crossed", () => {
    // 1.5 → 1.4: ceil(1.5)=2, ceil(1.4)=2, delta=0
    expect(stripeCeilDelta("1.5", "1.4")).toBe(0);
    // 1.0 → 0.5: ceil(1.0)=1, ceil(0.5)=1, delta=0
    expect(stripeCeilDelta("1.0", "0.5")).toBe(0);
  });

  it("returns positive int when balance dropped past a ceil-cent boundary (debit)", () => {
    // 1.5 → 0.5: ceil(1.5)=2, ceil(0.5)=1, delta=+1
    expect(stripeCeilDelta("1.5", "0.5")).toBe(1);
    // 100 → 95.5: ceil(100)=100, ceil(95.5)=96, delta=+4
    expect(stripeCeilDelta("100", "95.5")).toBe(4);
  });

  it("returns negative int when balance rose past a ceil-cent boundary (credit)", () => {
    // 0.5 → 1.5: ceil(0.5)=1, ceil(1.5)=2, delta=-1
    expect(stripeCeilDelta("0.5", "1.5")).toBe(-1);
    // 95.5 → 100: ceil(95.5)=96, ceil(100)=100, delta=-4
    expect(stripeCeilDelta("95.5", "100")).toBe(-4);
  });

  it("handles whole-cent moves exactly", () => {
    expect(stripeCeilDelta("100", "95")).toBe(5);
    expect(stripeCeilDelta("95", "100")).toBe(-5);
  });

  it("handles negative balances (Stripe ceil semantics)", () => {
    // -0.5 → -1.5: ceil(-0.5)=0, ceil(-1.5)=-1, delta=+1
    expect(stripeCeilDelta("-0.5", "-1.5")).toBe(1);
  });
});

describe("ceilToInt", () => {
  it("rounds up for positive fractional", () => {
    expect(ceilToInt("1.4")).toBe(2);
    expect(ceilToInt("0.0001")).toBe(1);
    expect(ceilToInt("100")).toBe(100);
  });

  it("rounds toward zero for negative fractional", () => {
    expect(ceilToInt("-1.4")).toBe(-1);
    expect(Math.abs(ceilToInt("-0.5"))).toBe(0);
  });
});
