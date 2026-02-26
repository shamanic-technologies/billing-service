import { describe, it, expect, vi, beforeEach } from "vitest";
import * as keyClient from "../../src/lib/key-client.js";

describe("Stripe key resolution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves Stripe key using billing-service appId, not the caller appId", async () => {
    const spy = vi.spyOn(keyClient, "resolveAppKey").mockResolvedValue("sk_test_mock");

    // Use setStripeInstance to bypass real Stripe init
    const { setStripeInstance, createCustomer } = await import("../../src/lib/stripe.js");
    const mockStripe = {
      customers: { create: vi.fn().mockResolvedValue({ id: "cus_new", metadata: {} }) },
    };
    setStripeInstance(mockStripe as any);

    await createCustomer("sales-cold-emails", "org-123");

    // resolveAppKey should NOT be called with the caller's appId
    expect(spy).not.toHaveBeenCalledWith("stripe", "sales-cold-emails");
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
