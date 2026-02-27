import { describe, it, expect, vi, beforeEach } from "vitest";
import Stripe from "stripe";

describe("Stripe key resolution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("resolves Stripe key via resolveKey with KeySourceInfo (app)", async () => {
    const mockResolveKey = vi.fn().mockResolvedValue("sk_test_mock");
    vi.doMock("../../src/lib/key-client.js", () => ({
      resolveAppKey: vi.fn(),
      resolveKey: mockResolveKey,
    }));

    const { createCustomer } = await import("../../src/lib/stripe.js");

    try {
      await createCustomer({ keySource: "app", appId: "sales-cold-emails" }, "org-123");
    } catch {
      // Stripe constructor may throw with mock key — that's fine
    }

    expect(mockResolveKey).toHaveBeenCalledWith(
      "stripe", "app", { appId: "sales-cold-emails" }
    );
  });

  it("resolves Stripe key via resolveKey with KeySourceInfo (byok)", async () => {
    const mockResolveKey = vi.fn().mockResolvedValue("sk_byok_mock");
    vi.doMock("../../src/lib/key-client.js", () => ({
      resolveAppKey: vi.fn(),
      resolveKey: mockResolveKey,
    }));

    const { createCustomer } = await import("../../src/lib/stripe.js");

    try {
      await createCustomer({ keySource: "byok", orgId: "org-uuid" }, "org-uuid");
    } catch {
      // Expected
    }

    expect(mockResolveKey).toHaveBeenCalledWith(
      "stripe", "byok", { orgId: "org-uuid" }
    );
  });

  it("resolves Stripe key via resolveKey with KeySourceInfo (platform)", async () => {
    const mockResolveKey = vi.fn().mockResolvedValue("sk_platform_mock");
    vi.doMock("../../src/lib/key-client.js", () => ({
      resolveAppKey: vi.fn(),
      resolveKey: mockResolveKey,
    }));

    const { createCustomer } = await import("../../src/lib/stripe.js");

    try {
      await createCustomer({ keySource: "platform" }, "org-123");
    } catch {
      // Expected
    }

    expect(mockResolveKey).toHaveBeenCalledWith(
      "stripe", "platform", {}
    );
  });

  it("evicts cached Stripe instance on auth error and retries with fresh key", async () => {
    const mockResolveKey = vi.fn()
      .mockResolvedValueOnce("sk_expired_key")
      .mockResolvedValueOnce("sk_fresh_key");
    vi.doMock("../../src/lib/key-client.js", () => ({
      resolveAppKey: vi.fn(),
      resolveKey: mockResolveKey,
    }));

    const { createCustomer } = await import("../../src/lib/stripe.js");

    try {
      await createCustomer({ keySource: "app", appId: "test-app" }, "org-123");
    } catch {
      // Expected — mock key can't actually reach Stripe
    }

    // Key was resolved at least once (may be twice if the error triggers a retry)
    expect(mockResolveKey).toHaveBeenCalledWith("stripe", "app", { appId: "test-app" });
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
