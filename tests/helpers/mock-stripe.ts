import { vi } from "vitest";
import Stripe from "stripe";
import * as stripeLib from "../../src/lib/stripe.js";
import * as keyClient from "../../src/lib/key-client.js";

/** Create a StripeAuthenticationError for testing. */
export function createStripeAuthError(message = "Expired API Key provided"): Stripe.errors.StripeAuthenticationError {
  return new Stripe.errors.StripeAuthenticationError({
    message,
    type: "invalid_request_error",
  });
}

/** Default mock implementations for all Stripe operations + key-service. */
export function setupStripeMocks() {
  const mocks = {
    createCustomer: vi.fn().mockResolvedValue({
      id: "cus_mock123",
      metadata: { org_id: "test-org" },
    }),
    createBalanceTransaction: vi.fn().mockResolvedValue({
      id: "cbtxn_mock",
      amount: -200,
      currency: "usd",
      description: "Trial credit",
    }),
    listBalanceTransactions: vi.fn().mockResolvedValue({
      data: [],
      has_more: false,
    }),
    createCheckoutSession: vi.fn().mockResolvedValue({
      id: "cs_mock_session",
      url: "https://checkout.stripe.com/pay/cs_mock_session",
    }),
    chargePaymentMethod: vi.fn().mockResolvedValue({
      id: "pi_mock",
      status: "succeeded",
      amount: 2000,
    }),
    constructWebhookEvent: vi.fn(),
    resolveAppKey: vi.fn().mockResolvedValue("sk_test_mock_key"),
    resolveByokKey: vi.fn().mockResolvedValue("sk_test_byok_key"),
    resolvePlatformKey: vi.fn().mockResolvedValue("sk_test_platform_key"),
    resolveKey: vi.fn().mockResolvedValue("sk_test_mock_key"),
    isStripeAuthError: vi.fn().mockImplementation(
      (err: unknown) => err instanceof Stripe.errors.StripeAuthenticationError
    ),
  };

  // Mock key-service so Stripe never actually calls it
  vi.spyOn(keyClient, "resolveAppKey").mockImplementation(mocks.resolveAppKey);
  vi.spyOn(keyClient, "resolveByokKey").mockImplementation(mocks.resolveByokKey);
  vi.spyOn(keyClient, "resolvePlatformKey").mockImplementation(mocks.resolvePlatformKey);
  vi.spyOn(keyClient, "resolveKey").mockImplementation(mocks.resolveKey);

  vi.spyOn(stripeLib, "createCustomer").mockImplementation(mocks.createCustomer);
  vi.spyOn(stripeLib, "createBalanceTransaction").mockImplementation(
    mocks.createBalanceTransaction
  );
  vi.spyOn(stripeLib, "listBalanceTransactions").mockImplementation(
    mocks.listBalanceTransactions
  );
  vi.spyOn(stripeLib, "createCheckoutSession").mockImplementation(
    mocks.createCheckoutSession
  );
  vi.spyOn(stripeLib, "chargePaymentMethod").mockImplementation(
    mocks.chargePaymentMethod
  );
  vi.spyOn(stripeLib, "constructWebhookEvent").mockImplementation(
    mocks.constructWebhookEvent
  );
  vi.spyOn(stripeLib, "isStripeAuthError").mockImplementation(
    mocks.isStripeAuthError
  );

  return mocks;
}
