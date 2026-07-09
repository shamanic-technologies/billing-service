import { describe, it, expect } from "vitest";
import {
  parsePositiveCents,
  parseNonNegativeCents,
  addCents,
  subCents,
  cmpCents,
  isDepleted,
  gte,
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

  it("isDepleted true for ≤ 0 (default threshold 0)", () => {
    expect(isDepleted("0")).toBe(true);
    expect(isDepleted("-0.0001")).toBe(true);
    expect(isDepleted("0.0000000001")).toBe(false);
  });

  it("isDepleted threshold-aware: depleted only at/below the negative floor", () => {
    // Within the credit line (above the floor) → NOT depleted.
    expect(isDepleted("-30", "-5000")).toBe(false);
    expect(isDepleted("-4999.9999999999", "-5000")).toBe(false);
    // At or past the floor → depleted.
    expect(isDepleted("-5000", "-5000")).toBe(true);
    expect(isDepleted("-5000.0000000001", "-5000")).toBe(true);
    // A normal positive balance is never depleted against a negative floor.
    expect(isDepleted("100", "-5000")).toBe(false);
  });

  it("gte handles fractions", () => {
    expect(gte("100.0001", "100")).toBe(true);
    expect(gte("100", "100.0001")).toBe(false);
    expect(gte("100", "100")).toBe(true);
  });
});
