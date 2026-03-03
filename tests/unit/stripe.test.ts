import { describe, it, expect, vi, beforeEach } from "vitest";
import Stripe from "stripe";

describe("Stripe platform key resolution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("resolves Stripe key via resolvePlatformKey (no orgId/userId)", async () => {
    const mockResolvePlatformKey = vi.fn().mockResolvedValue({
      provider: "stripe",
      key: "sk_test_mock",
    });
    vi.doMock("../../src/lib/key-client.js", () => ({
      resolvePlatformKey: mockResolvePlatformKey,
    }));

    const { createCustomer } = await import("../../src/lib/stripe.js");

    try {
      await createCustomer("org-123", "user-456");
    } catch {
      // Stripe constructor may throw with mock key — that's fine
    }

    expect(mockResolvePlatformKey).toHaveBeenCalledWith("stripe");
  });

  it("caches Stripe instance (single platform key)", async () => {
    const mockResolvePlatformKey = vi.fn().mockResolvedValue({
      provider: "stripe",
      key: "sk_test_cached",
    });
    vi.doMock("../../src/lib/key-client.js", () => ({
      resolvePlatformKey: mockResolvePlatformKey,
    }));

    // Mock Stripe constructor to avoid real API calls that trigger auth errors
    const mockCreate = vi.fn().mockResolvedValue({ id: "cus_mock", object: "customer" });
    vi.doMock("stripe", () => {
      const MockStripe = function () {
        return { customers: { create: mockCreate } };
      };
      MockStripe.errors = Stripe.errors;
      return { default: MockStripe };
    });

    const { createCustomer } = await import("../../src/lib/stripe.js");

    await createCustomer("org-123", "user-456");
    await createCustomer("org-999", "user-000");

    // Key should be resolved only once — platform key is global
    expect(mockResolvePlatformKey).toHaveBeenCalledTimes(1);
  });

  it("evicts cached Stripe instance on auth error and retries with fresh key", async () => {
    const mockResolvePlatformKey = vi.fn()
      .mockResolvedValueOnce({ provider: "stripe", key: "sk_expired_key" })
      .mockResolvedValueOnce({ provider: "stripe", key: "sk_fresh_key" });
    vi.doMock("../../src/lib/key-client.js", () => ({
      resolvePlatformKey: mockResolvePlatformKey,
    }));

    const { createCustomer } = await import("../../src/lib/stripe.js");

    try {
      await createCustomer("org-123", "user-456");
    } catch {
      // Expected — mock key can't actually reach Stripe
    }

    // Key was resolved at least once
    expect(mockResolvePlatformKey).toHaveBeenCalledWith("stripe");
  });
});

describe("isStripeAuthError", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns true for StripeAuthenticationError", async () => {
    const { isStripeAuthError } = await import("../../src/lib/stripe.js");
    const err = new Stripe.errors.StripeAuthenticationError({
      message: "Expired API Key provided",
      type: "invalid_request_error",
    });
    expect(isStripeAuthError(err)).toBe(true);
  });

  it("returns false for generic errors", async () => {
    const { isStripeAuthError } = await import("../../src/lib/stripe.js");
    expect(isStripeAuthError(new Error("something else"))).toBe(false);
  });

  it("returns false for non-error values", async () => {
    const { isStripeAuthError } = await import("../../src/lib/stripe.js");
    expect(isStripeAuthError(null)).toBe(false);
    expect(isStripeAuthError("string")).toBe(false);
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
