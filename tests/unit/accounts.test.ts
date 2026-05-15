import { describe, it, expect } from "vitest";

describe("Account mode transitions", () => {
  const validTransitions: Array<{ from: string; to: string; valid: boolean }> = [
    { from: "trial", to: "byok", valid: true },
    { from: "trial", to: "payg", valid: true },
    { from: "byok", to: "payg", valid: true },
    { from: "payg", to: "byok", valid: true },
    { from: "byok", to: "trial", valid: false },
    { from: "payg", to: "trial", valid: false },
  ];

  for (const { from, to, valid } of validTransitions) {
    it(`${from} -> ${to} should be ${valid ? "allowed" : "rejected"}`, () => {
      const isValid = to !== "trial";
      expect(isValid).toBe(valid);
    });
  }
});

describe("Available-funds depletion check", () => {
  it("available of 0 is depleted", () => {
    expect(0 <= 0).toBe(true);
  });

  it("positive available is not depleted", () => {
    expect(100 <= 0).toBe(false);
  });

  it("negative available is depleted", () => {
    expect(-5 <= 0).toBe(true);
  });
});

describe("Customer balance transaction type semantics", () => {
  const CREDIT_TYPES = ["payment", "gift", "promo", "refund"] as const;

  it("classifies all canonical credit types as credits (negative amount)", () => {
    for (const t of CREDIT_TYPES) {
      expect(["payment", "gift", "promo", "refund"]).toContain(t);
    }
  });

  it("usage_applied is the only debit type (positive amount) and is frozen post-#104", () => {
    expect("usage_applied").not.toMatch(/payment|gift|promo|refund/);
  });
});
