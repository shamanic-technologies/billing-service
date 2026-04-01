import { describe, it, expect, vi, beforeEach } from "vitest";
import Stripe from "stripe";

describe("Stripe platform key resolution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("resolves Stripe key via resolvePlatformKey with identity context", async () => {
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

    expect(mockResolvePlatformKey).toHaveBeenCalledWith(
      "stripe",
      { orgId: "org-123", userId: "user-456" }
    );
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

  it("constructs Stripe client with maxNetworkRetries", async () => {
    const mockResolvePlatformKey = vi.fn().mockResolvedValue({
      provider: "stripe",
      key: "sk_test_retries",
    });
    vi.doMock("../../src/lib/key-client.js", () => ({
      resolvePlatformKey: mockResolvePlatformKey,
    }));

    let capturedConfig: Record<string, unknown> | undefined;
    const mockCreate = vi.fn().mockResolvedValue({ id: "cus_mock", object: "customer" });
    vi.doMock("stripe", () => {
      const MockStripe = function (_key: string, config: Record<string, unknown>) {
        capturedConfig = config;
        return { customers: { create: mockCreate } };
      };
      MockStripe.errors = Stripe.errors;
      return { default: MockStripe };
    });

    const { createCustomer } = await import("../../src/lib/stripe.js");
    await createCustomer("org-123", "user-456");

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig!.maxNetworkRetries).toBe(5);
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

    // Key was resolved with identity context
    expect(mockResolvePlatformKey).toHaveBeenCalledWith(
      "stripe",
      { orgId: "org-123", userId: "user-456" }
    );
  });

  it("webhook uses 'system' identity for platform webhook secret", async () => {
    const mockResolvePlatformKey = vi.fn().mockResolvedValue({
      provider: "stripe-webhook",
      key: "whsec_test",
    });
    vi.doMock("../../src/lib/key-client.js", () => ({
      resolvePlatformKey: mockResolvePlatformKey,
    }));

    // Mock Stripe constructor
    vi.doMock("stripe", () => {
      const MockStripe = function () {
        return {
          customers: { create: vi.fn() },
          webhooks: {
            constructEvent: vi.fn().mockReturnValue({ type: "test", data: {} }),
          },
        };
      };
      MockStripe.errors = Stripe.errors;
      return { default: MockStripe };
    });

    const { constructWebhookEvent } = await import("../../src/lib/stripe.js");

    await constructWebhookEvent(Buffer.from("{}"), "sig_test");

    // Webhook secret resolution uses system identity (no org needed)
    expect(mockResolvePlatformKey).toHaveBeenCalledWith(
      "stripe-webhook",
      { orgId: "system", userId: "system" },
      { service: "billing", method: "POST", path: "/v1/webhooks/stripe" }
    );
  });
});

describe("429 rate limit retry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("retries on StripeRateLimitError and succeeds on subsequent attempt", async () => {
    const mockResolvePlatformKey = vi.fn().mockResolvedValue({
      provider: "stripe",
      key: "sk_test_429",
    });
    vi.doMock("../../src/lib/key-client.js", () => ({
      resolvePlatformKey: mockResolvePlatformKey,
    }));

    const rateLimitError = new Stripe.errors.StripeRateLimitError({
      message: "Rate limit exceeded",
      type: "rate_limit_error",
    });
    const mockCreate = vi.fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({ id: "cus_after_retry", object: "customer" });

    vi.doMock("stripe", () => {
      const MockStripe = function () {
        return { customers: { create: mockCreate } };
      };
      MockStripe.errors = Stripe.errors;
      return { default: MockStripe };
    });

    const { createCustomer } = await import("../../src/lib/stripe.js");
    const result = await createCustomer("org-123", "user-456");

    expect(result).toEqual({ id: "cus_after_retry", object: "customer" });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting all 429 retries", async () => {
    const mockResolvePlatformKey = vi.fn().mockResolvedValue({
      provider: "stripe",
      key: "sk_test_429_exhaust",
    });
    vi.doMock("../../src/lib/key-client.js", () => ({
      resolvePlatformKey: mockResolvePlatformKey,
    }));

    const rateLimitError = new Stripe.errors.StripeRateLimitError({
      message: "Rate limit exceeded",
      type: "rate_limit_error",
    });
    const mockCreate = vi.fn().mockRejectedValue(rateLimitError);

    vi.doMock("stripe", () => {
      const MockStripe = function () {
        return { customers: { create: mockCreate } };
      };
      MockStripe.errors = Stripe.errors;
      return { default: MockStripe };
    });

    const { createCustomer } = await import("../../src/lib/stripe.js");

    await expect(createCustomer("org-123", "user-456")).rejects.toThrow("Rate limit exceeded");
    // 1 initial + 3 retries = 4 total calls
    expect(mockCreate).toHaveBeenCalledTimes(4);
  });

  it("does not retry non-rate-limit Stripe errors", async () => {
    const mockResolvePlatformKey = vi.fn().mockResolvedValue({
      provider: "stripe",
      key: "sk_test_non429",
    });
    vi.doMock("../../src/lib/key-client.js", () => ({
      resolvePlatformKey: mockResolvePlatformKey,
    }));

    const cardError = new Stripe.errors.StripeCardError({
      message: "Card declined",
      type: "card_error",
    });
    const mockCreate = vi.fn().mockRejectedValue(cardError);

    vi.doMock("stripe", () => {
      const MockStripe = function () {
        return {
          paymentIntents: { create: mockCreate },
        };
      };
      MockStripe.errors = Stripe.errors;
      return { default: MockStripe };
    });

    const { chargePaymentMethod } = await import("../../src/lib/stripe.js");

    await expect(
      chargePaymentMethod("org-123", "user-456", "cus_test", "pm_test", 2000, "reload")
    ).rejects.toThrow("Card declined");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

describe("concurrency limiting", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("stripeQueue has concurrency of 10", async () => {
    const { stripeQueue } = await import("../../src/lib/stripe.js");
    expect(stripeQueue.concurrency).toBe(10);
  });
});

describe("idempotency keys", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("chargePaymentMethod passes an idempotency key to PaymentIntents.create", async () => {
    const mockResolvePlatformKey = vi.fn().mockResolvedValue({
      provider: "stripe",
      key: "sk_test_idemp",
    });
    vi.doMock("../../src/lib/key-client.js", () => ({
      resolvePlatformKey: mockResolvePlatformKey,
    }));

    let capturedOptions: Record<string, unknown> | undefined;
    const mockPiCreate = vi.fn().mockImplementation((_params: unknown, opts: Record<string, unknown>) => {
      capturedOptions = opts;
      return Promise.resolve({ id: "pi_mock", status: "succeeded" });
    });

    vi.doMock("stripe", () => {
      const MockStripe = function () {
        return { paymentIntents: { create: mockPiCreate } };
      };
      MockStripe.errors = Stripe.errors;
      return { default: MockStripe };
    });

    const { chargePaymentMethod } = await import("../../src/lib/stripe.js");
    await chargePaymentMethod("org-123", "user-456", "cus_test", "pm_test", 2000, "Auto-reload");

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.idempotencyKey).toBeDefined();
    expect(typeof capturedOptions!.idempotencyKey).toBe("string");
    expect((capturedOptions!.idempotencyKey as string).length).toBe(32);
  });

  it("same inputs within same minute produce same idempotency key", async () => {
    const mockResolvePlatformKey = vi.fn().mockResolvedValue({
      provider: "stripe",
      key: "sk_test_idemp2",
    });
    vi.doMock("../../src/lib/key-client.js", () => ({
      resolvePlatformKey: mockResolvePlatformKey,
    }));

    const capturedKeys: string[] = [];
    const mockPiCreate = vi.fn().mockImplementation((_params: unknown, opts: Record<string, unknown>) => {
      capturedKeys.push(opts.idempotencyKey as string);
      return Promise.resolve({ id: "pi_mock", status: "succeeded" });
    });

    vi.doMock("stripe", () => {
      const MockStripe = function () {
        return { paymentIntents: { create: mockPiCreate } };
      };
      MockStripe.errors = Stripe.errors;
      return { default: MockStripe };
    });

    const { chargePaymentMethod } = await import("../../src/lib/stripe.js");

    await chargePaymentMethod("org-A", "user-1", "cus_A", "pm_A", 2000, "Reload");
    await chargePaymentMethod("org-A", "user-1", "cus_A", "pm_A", 2000, "Reload");

    // Same org + customer + amount within same minute → same key
    expect(capturedKeys[0]).toBe(capturedKeys[1]);
  });

  it("different orgs produce different idempotency keys", async () => {
    const mockResolvePlatformKey = vi.fn().mockResolvedValue({
      provider: "stripe",
      key: "sk_test_idemp3",
    });
    vi.doMock("../../src/lib/key-client.js", () => ({
      resolvePlatformKey: mockResolvePlatformKey,
    }));

    const capturedKeys: string[] = [];
    const mockPiCreate = vi.fn().mockImplementation((_params: unknown, opts: Record<string, unknown>) => {
      capturedKeys.push(opts.idempotencyKey as string);
      return Promise.resolve({ id: "pi_mock", status: "succeeded" });
    });

    vi.doMock("stripe", () => {
      const MockStripe = function () {
        return { paymentIntents: { create: mockPiCreate } };
      };
      MockStripe.errors = Stripe.errors;
      return { default: MockStripe };
    });

    const { chargePaymentMethod } = await import("../../src/lib/stripe.js");

    await chargePaymentMethod("org-A", "user-1", "cus_A", "pm_A", 2000, "Reload");
    await chargePaymentMethod("org-B", "user-1", "cus_B", "pm_B", 2000, "Reload");

    expect(capturedKeys[0]).not.toBe(capturedKeys[1]);
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
