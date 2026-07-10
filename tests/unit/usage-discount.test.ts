import { describe, it, expect } from "vitest";
import { applyUsageDiscount } from "../../src/lib/usage-discount.js";

describe("applyUsageDiscount", () => {
  it("returns gross verbatim when discount is null (byte-identical, no reformat)", () => {
    expect(applyUsageDiscount("40.0000000000", null)).toBe("40.0000000000");
    // Whatever string runs-service returned is passed through untouched.
    expect(applyUsageDiscount("13.37", null)).toBe("13.37");
  });

  it("returns gross verbatim when discount is 0 (explicit no-op discount)", () => {
    expect(applyUsageDiscount("40.0000000000", 0)).toBe("40.0000000000");
  });

  it("halves usage at 50%", () => {
    expect(applyUsageDiscount("100.0000000000", 50)).toBe("50.0000000000");
  });

  it("zeroes usage at 100%", () => {
    expect(applyUsageDiscount("100.0000000000", 100)).toBe("0.0000000000");
  });

  it("applies a 25% discount (keeps 75%)", () => {
    expect(applyUsageDiscount("200.0000000000", 25)).toBe("150.0000000000");
  });

  it("preserves fractional-cents precision (non-tie rounding)", () => {
    // 33.3333333333 × 0.9 = 29.99999999997 → rounds up at scale 10 (7 > 5),
    // deterministic regardless of the global Decimal rounding mode.
    expect(applyUsageDiscount("33.3333333333", 10)).toBe("30.0000000000");
  });

  it("applies a 1% discount", () => {
    expect(applyUsageDiscount("100.0000000000", 1)).toBe("99.0000000000");
  });
});
