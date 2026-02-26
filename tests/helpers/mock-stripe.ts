import { vi } from "vitest";
import * as stripeLib from "../../src/lib/stripe.js";
import * as keyClient from "../../src/lib/key-client.js";

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
  };

  // Mock key-service so Stripe never actually calls it
  vi.spyOn(keyClient, "resolveAppKey").mockImplementation(mocks.resolveAppKey);

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

  return mocks;
}
