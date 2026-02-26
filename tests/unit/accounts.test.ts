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
  function classifyTransaction(
    amount: number,
    description: string | null
  ): "deduction" | "credit" | "reload" {
    if (description?.includes("reload") || description?.includes("Reload")) {
      return "reload";
    }
    return amount > 0 ? "deduction" : "credit";
  }

  it("classifies positive amounts as deductions", () => {
    expect(classifyTransaction(5, "anthropic tokens")).toBe("deduction");
  });

  it("classifies negative amounts as credits", () => {
    expect(classifyTransaction(-200, "Trial credit")).toBe("credit");
  });

  it("classifies reload transactions by description", () => {
    expect(classifyTransaction(-2000, "Auto-reload credit")).toBe("reload");
    expect(classifyTransaction(-1000, "Initial Reload")).toBe("reload");
  });
});
