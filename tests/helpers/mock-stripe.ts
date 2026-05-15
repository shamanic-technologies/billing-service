import { vi } from "vitest";
import * as ssClient from "../../src/lib/stripe-service-client.js";
import { _resetCoalescer } from "../../src/lib/reload-coalescer.js";

export interface StripeServiceMocks {
  ensureCustomer: ReturnType<typeof vi.fn>;
  getBalance: ReturnType<typeof vi.fn>;
  hasPaymentMethod: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  createCheckoutSession: ReturnType<typeof vi.fn>;
  createPortalSession: ReturnType<typeof vi.fn>;
  listTransactions: ReturnType<typeof vi.fn>;
  transferBrand: ReturnType<typeof vi.fn>;
  getStats: ReturnType<typeof vi.fn>;
}

/**
 * Replace every stripe-service-client export with a vi.fn() and seed sane
 * defaults. Returns the mock collection so individual tests can assert calls
 * or override return values.
 */
export function setupStripeMocks(): StripeServiceMocks {
  _resetCoalescer();

  const mocks: StripeServiceMocks = {
    ensureCustomer: vi.fn().mockResolvedValue({ customer_id: "cus_mock_123" }),
    getBalance: vi.fn().mockResolvedValue({ balance_cents: "0.0000000000" }),
    hasPaymentMethod: vi.fn().mockResolvedValue({ has_payment_method: false }),
    reload: vi.fn().mockResolvedValue({
      status: "succeeded",
      payment_intent_id: "pi_mock",
    }),
    createCheckoutSession: vi.fn().mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_mock",
      session_id: "cs_mock",
    }),
    createPortalSession: vi.fn().mockResolvedValue({
      url: "https://billing.stripe.com/p/session/test_portal",
    }),
    listTransactions: vi.fn().mockResolvedValue({
      object: "list",
      data: [],
      has_more: false,
    }),
    transferBrand: vi.fn().mockResolvedValue({ count: 0 }),
    getStats: vi.fn().mockResolvedValue({
      total_paid_cents: "0.0000000000",
      accounts_with_payment_method: 0,
      monthly_growth: [],
      weekly_growth: [],
    }),
  };

  vi.spyOn(ssClient, "ensureCustomer").mockImplementation(mocks.ensureCustomer);
  vi.spyOn(ssClient, "getBalance").mockImplementation(mocks.getBalance);
  vi.spyOn(ssClient, "hasPaymentMethod").mockImplementation(mocks.hasPaymentMethod);
  vi.spyOn(ssClient, "reload").mockImplementation(mocks.reload);
  vi.spyOn(ssClient, "createCheckoutSession").mockImplementation(mocks.createCheckoutSession);
  vi.spyOn(ssClient, "createPortalSession").mockImplementation(mocks.createPortalSession);
  vi.spyOn(ssClient, "listTransactions").mockImplementation(mocks.listTransactions);
  vi.spyOn(ssClient, "transferBrand").mockImplementation(mocks.transferBrand);
  vi.spyOn(ssClient, "getStats").mockImplementation(mocks.getStats);

  return mocks;
}
