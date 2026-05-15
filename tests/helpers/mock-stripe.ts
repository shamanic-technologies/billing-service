import { vi } from "vitest";
import * as ssClient from "../../src/lib/stripe-service-client.js";
import * as reload from "../../src/lib/reload.js";
import { _resetCoalescer } from "../../src/lib/reload-coalescer.js";

export interface StripeServiceMocks {
  ensureCustomer: ReturnType<typeof vi.fn>;
  getCustomerByOrg: ReturnType<typeof vi.fn>;
  createPaymentIntent: ReturnType<typeof vi.fn>;
  getPaymentIntent: ReturnType<typeof vi.fn>;
  listBalanceTransactions: ReturnType<typeof vi.fn>;
  createCheckoutSession: ReturnType<typeof vi.fn>;
  createPortalSession: ReturnType<typeof vi.fn>;
  transferBrand: ReturnType<typeof vi.fn>;
  getStats: ReturnType<typeof vi.fn>;
  reloadViaPaymentIntent: ReturnType<typeof vi.fn>;
}

const MOCK_CUSTOMER_ID = "cus_mock_123";

function buildMockCustomer(overrides: Partial<ssClient.StripeCustomer> = {}): ssClient.StripeCustomer {
  return {
    id: MOCK_CUSTOMER_ID,
    object: "customer",
    balance: 0,
    metadata: {},
    invoice_settings: { default_payment_method: null },
    ...overrides,
  };
}

/**
 * Replace every stripe-service-client export with a vi.fn() and seed sane
 * defaults. Returns the mock collection so individual tests can assert calls
 * or override return values.
 *
 * `reloadViaPaymentIntent` is mocked at the helper layer (lib/reload.ts) — that
 * keeps test ergonomics close to the old `reload` mock.
 */
export function setupStripeMocks(): StripeServiceMocks {
  _resetCoalescer();

  const mocks: StripeServiceMocks = {
    ensureCustomer: vi.fn().mockResolvedValue({ customer_id: MOCK_CUSTOMER_ID }),
    getCustomerByOrg: vi.fn().mockResolvedValue(buildMockCustomer()),
    createPaymentIntent: vi.fn().mockResolvedValue({
      id: "pi_mock",
      object: "payment_intent",
      amount: 0,
      currency: "usd",
      customer: MOCK_CUSTOMER_ID,
      status: "succeeded",
      last_payment_error: null,
    }),
    getPaymentIntent: vi.fn().mockResolvedValue({
      id: "pi_mock",
      object: "payment_intent",
      amount: 0,
      currency: "usd",
      customer: MOCK_CUSTOMER_ID,
      status: "succeeded",
      last_payment_error: null,
    }),
    listBalanceTransactions: vi.fn().mockResolvedValue({
      object: "list",
      url: "/v1/balance_transactions",
      data: [],
      has_more: false,
    }),
    createCheckoutSession: vi.fn().mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_mock",
      session_id: "cs_mock",
    }),
    createPortalSession: vi.fn().mockResolvedValue({
      url: "https://billing.stripe.com/p/session/test_portal",
    }),
    transferBrand: vi.fn().mockResolvedValue({ count: 0 }),
    getStats: vi.fn().mockResolvedValue({
      total_paid_cents: "0.0000000000",
      accounts_with_payment_method: 0,
      monthly_growth: [],
      weekly_growth: [],
    }),
    reloadViaPaymentIntent: vi.fn().mockResolvedValue({
      status: "succeeded",
      payment_intent_id: "pi_mock",
    }),
  };

  vi.spyOn(ssClient, "ensureCustomer").mockImplementation(mocks.ensureCustomer);
  vi.spyOn(ssClient, "getCustomerByOrg").mockImplementation(mocks.getCustomerByOrg);
  vi.spyOn(ssClient, "createPaymentIntent").mockImplementation(mocks.createPaymentIntent);
  vi.spyOn(ssClient, "getPaymentIntent").mockImplementation(mocks.getPaymentIntent);
  vi.spyOn(ssClient, "listBalanceTransactions").mockImplementation(mocks.listBalanceTransactions);
  vi.spyOn(ssClient, "createCheckoutSession").mockImplementation(mocks.createCheckoutSession);
  vi.spyOn(ssClient, "createPortalSession").mockImplementation(mocks.createPortalSession);
  vi.spyOn(ssClient, "transferBrand").mockImplementation(mocks.transferBrand);
  vi.spyOn(ssClient, "getStats").mockImplementation(mocks.getStats);
  vi.spyOn(reload, "reloadViaPaymentIntent").mockImplementation(mocks.reloadViaPaymentIntent);

  return mocks;
}

/**
 * Helper: build a customer with a specific Stripe `balance` (Stripe sign:
 * negative = credit). Test code stays in Stripe's native units.
 */
export function customerWithStripeBalance(stripeBalance: number, overrides: Partial<ssClient.StripeCustomer> = {}): ssClient.StripeCustomer {
  return buildMockCustomer({ balance: stripeBalance, ...overrides });
}

/**
 * Helper: build a customer that mirrors billing's "balance_cents" (positive =
 * credit). Sign-flipped to Stripe convention internally.
 */
export function customerWithBillingCredits(billingBalanceCents: number, overrides: Partial<ssClient.StripeCustomer> = {}): ssClient.StripeCustomer {
  return buildMockCustomer({ balance: -billingBalanceCents, ...overrides });
}

/**
 * Helper: build a customer that has a default payment method attached.
 */
export function customerWithDefaultPM(overrides: Partial<ssClient.StripeCustomer> = {}): ssClient.StripeCustomer {
  return buildMockCustomer({
    invoice_settings: { default_payment_method: "pm_mock_card" },
    ...overrides,
  });
}
