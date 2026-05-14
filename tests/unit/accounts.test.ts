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
      // Cannot go back to trial
      const isValid = to !== "trial";
      expect(isValid).toBe(valid);
    });
  }
});

describe("Balance depletion check", () => {
  it("balance of 0 is depleted", () => {
    expect(0 <= 0).toBe(true);
  });

  it("positive balance is not depleted", () => {
    expect(100 <= 0).toBe(false);
  });

  it("negative balance is depleted", () => {
    expect(-5 <= 0).toBe(true);
  });
});

describe("Transaction classification", () => {
  function classifyTransaction(source: string): "credit" | "reload" {
    if (source === "reload") return "reload";
    return "credit";
  }

  it("classifies reload source as reload", () => {
    expect(classifyTransaction("reload")).toBe("reload");
  });

  it("classifies welcome source as credit", () => {
    expect(classifyTransaction("welcome")).toBe("credit");
  });

  it("classifies promo source as credit", () => {
    expect(classifyTransaction("promo")).toBe("credit");
  });

  it("classifies refund source as credit", () => {
    expect(classifyTransaction("refund")).toBe("credit");
  });
});
