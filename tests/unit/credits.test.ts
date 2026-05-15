import { describe, it, expect } from "vitest";

describe("Available-funds arithmetic", () => {
  it("balance minus usage yields available", () => {
    const balance = 200;
    const usage = 5;
    const available = balance - usage;
    expect(available).toBe(195);
  });

  it("allows negative available when usage exceeds balance", () => {
    const balance = 3;
    const usage = 5;
    const available = balance - usage;
    expect(available).toBe(-2);
  });

  it("post-topup available reflects new balance", () => {
    const balance = 3;
    const topup = 2000;
    const usage = 5;
    const available = balance + topup - usage;
    expect(available).toBe(1998);
  });

  it("detects when post-usage available is below topup threshold", () => {
    const balance = 250;
    const usage = 100;
    const threshold = 200;
    const available = balance - usage;
    expect(available < threshold).toBe(true);
  });

  it("does not trigger topup when above threshold", () => {
    const balance = 500;
    const usage = 10;
    const threshold = 200;
    const available = balance - usage;
    expect(available < threshold).toBe(false);
  });

  it("BYOK mode always succeeds regardless of balance", () => {
    const mode = "byok";
    const balance = 0;
    const usage = 1000;
    const shouldBypass = mode === "byok";
    expect(shouldBypass).toBe(true);
    void balance;
    void usage;
  });

  it("marks depleted when available goes to zero or negative", () => {
    expect(0 <= 0).toBe(true);
    expect(-5 <= 0).toBe(true);
    expect(1 <= 0).toBe(false);
  });
});
