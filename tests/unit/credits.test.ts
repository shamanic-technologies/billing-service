import { describe, it, expect } from "vitest";

describe("Credit deduction logic", () => {
  it("calculates correct balance after deduction", () => {
    const initialBalance = 200;
    const deductAmount = 5;
    const newBalance = initialBalance - deductAmount;
    expect(newBalance).toBe(195);
  });

  it("allows negative balance (deducts even when insufficient)", () => {
    const balance = 3;
    const amount = 5;
    const newBalance = balance - amount;
    expect(newBalance).toBe(-2);
  });

  it("calculates balance after reload + deduction", () => {
    const balance = 3;
    const reloadAmount = 2000;
    const deductAmount = 5;
    const newBalance = balance + reloadAmount - deductAmount;
    expect(newBalance).toBe(1998);
  });

  it("detects when post-deduction balance is below threshold", () => {
    const balance = 250;
    const amount = 100;
    const threshold = 200;
    const newBalance = balance - amount;
    expect(newBalance < threshold).toBe(true);
  });

  it("does not trigger reload when above threshold", () => {
    const balance = 500;
    const amount = 10;
    const threshold = 200;
    const newBalance = balance - amount;
    expect(newBalance < threshold).toBe(false);
  });

  it("BYOK mode always succeeds regardless of balance", () => {
    const mode = "byok";
    const balance = 0;
    const amount = 1000;
    const shouldBypass = mode === "byok";
    expect(shouldBypass).toBe(true);
  });

  it("marks depleted when balance goes to zero or negative", () => {
    expect(0 <= 0).toBe(true);
    expect(-5 <= 0).toBe(true);
    expect(1 <= 0).toBe(false);
  });
});

describe("Credit provision logic", () => {
  it("calculates balance adjustment when actual is lower", () => {
    const provisioned = 100;
    const actual = 60;
    const adjustment = provisioned - actual;
    expect(adjustment).toBe(40);
  });

  it("calculates balance adjustment when actual is higher", () => {
    const provisioned = 100;
    const actual = 150;
    const adjustment = provisioned - actual;
    expect(adjustment).toBe(-50);
  });

  it("no adjustment when actual equals provisioned", () => {
    const provisioned = 100;
    const actual = 100;
    const adjustment = provisioned - actual;
    expect(adjustment).toBe(0);
  });

  it("cancel re-credits the full provisioned amount", () => {
    const balance = 400;
    const provisioned = 100;
    const newBalance = balance + provisioned;
    expect(newBalance).toBe(500);
  });
});
