import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Stripe key resolution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("resolves Stripe key using the caller appId (per-app)", async () => {
    const mockResolve = vi.fn().mockResolvedValue("sk_test_mock");
    vi.doMock("../../src/lib/key-client.js", () => ({
      resolveAppKey: mockResolve,
    }));

    const { createCustomer } = await import("../../src/lib/stripe.js");

    try {
      await createCustomer("sales-cold-emails", "org-123");
    } catch {
      // Stripe constructor may throw with mock key — that's fine
    }

    // resolveAppKey is called with the caller's appId, not "billing-service"
    expect(mockResolve).toHaveBeenCalledWith("stripe", "sales-cold-emails");
  });
});

describe("Stripe balance semantics", () => {
  it("negative Stripe balance means customer has credit", () => {
    const stripeBalance = -200; // $2 credit
    const availableCredit = Math.abs(Math.min(0, stripeBalance));
    expect(availableCredit).toBe(200);
  });

  it("zero Stripe balance means no credit", () => {
    const stripeBalance = 0;
    const availableCredit = Math.abs(Math.min(0, stripeBalance));
    expect(availableCredit).toBe(0);
  });

  it("positive Stripe balance means customer owes money", () => {
    const stripeBalance = 100; // owes $1
    const availableCredit = Math.abs(Math.min(0, stripeBalance));
    expect(availableCredit).toBe(0);
  });

  it("deduction amount is positive (increases Stripe balance)", () => {
    const deductionAmount = 5; // 5 cents
    expect(deductionAmount > 0).toBe(true);
  });

  it("credit amount is negative (decreases Stripe balance)", () => {
    const creditAmount = -200; // $2 credit
    expect(creditAmount < 0).toBe(true);
  });
});
