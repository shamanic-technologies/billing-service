import { vi } from "vitest";
import * as ssClient from "../../src/lib/stripe-service-client.js";
import * as reload from "../../src/lib/reload.js";
import { _resetCoalescer } from "../../src/lib/reload-coalescer.js";

export interface StripeServiceMocks {
  ensureCustomer: ReturnType<typeof vi.fn>;
  getCustomerByOrg: ReturnType<typeof vi.fn>;
  createPaymentIntent: ReturnType<typeof vi.fn>;
  getPaymentIntent: ReturnType<typeof vi.fn>;
  listPaymentIntents: ReturnType<typeof vi.fn>;
  listPaymentMethods: ReturnType<typeof vi.fn>;
  hasAttachedCardPm: ReturnType<typeof vi.fn>;
  getOrgCardCountry: ReturnType<typeof vi.fn>;
  getOrgCardDisplay: ReturnType<typeof vi.fn>;
  sumSucceededTopupsForCustomer: ReturnType<typeof vi.fn>;
  // User-less org-keyed reads (balance path — computeBalance).
  fetchOrgCustomer: ReturnType<typeof vi.fn>;
  sumSucceededTopupsForOrg: ReturnType<typeof vi.fn>;
  hasChargeablePmForOrg: ReturnType<typeof vi.fn>;
  getOrgCardCountryByOrg: ReturnType<typeof vi.fn>;
  listCustomersByMetadata: ReturnType<typeof vi.fn>;
  updateCustomer: ReturnType<typeof vi.fn>;
  createCheckoutSession: ReturnType<typeof vi.fn>;
  createPortalSession: ReturnType<typeof vi.fn>;
  getStats: ReturnType<typeof vi.fn>;
  reloadViaInvoice: ReturnType<typeof vi.fn>;
}

const MOCK_CUSTOMER_ID = "cus_mock_123";

function buildMockCustomer(overrides: Partial<ssClient.StripeCustomer> = {}): ssClient.StripeCustomer {
  return {
    id: MOCK_CUSTOMER_ID,
    object: "customer",
    email: null,
    metadata: {},
    invoice_settings: { default_payment_method: null },
    ...overrides,
  };
}

/** Build a customer carrying a billing email (dunning recipient). */
export function customerWithEmail(
  email: string,
  overrides: Partial<ssClient.StripeCustomer> = {}
): ssClient.StripeCustomer {
  return buildMockCustomer({ email, ...overrides });
}

/**
 * Replace every stripe-service-client export with a vi.fn() and seed sane
 * defaults. Returns the mock collection so individual tests can assert calls
 * or override return values.
 *
 * `reloadViaInvoice` is mocked at the helper layer (lib/reload.ts) — that
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
      amount_received: 0,
      currency: "usd",
      customer: MOCK_CUSTOMER_ID,
      status: "succeeded",
      last_payment_error: null,
    }),
    getPaymentIntent: vi.fn().mockResolvedValue({
      id: "pi_mock",
      object: "payment_intent",
      amount: 0,
      amount_received: 0,
      currency: "usd",
      customer: MOCK_CUSTOMER_ID,
      status: "succeeded",
      last_payment_error: null,
    }),
    listPaymentIntents: vi.fn().mockResolvedValue({
      object: "list",
      url: "/v1/payment_intents",
      data: [],
      has_more: false,
    }),
    listPaymentMethods: vi.fn().mockResolvedValue({
      object: "list",
      url: "/v1/payment_methods",
      data: [
        { id: "pm_mock_card", object: "payment_method", type: "card" },
      ],
      has_more: false,
    }),
    hasAttachedCardPm: vi.fn().mockResolvedValue(true),
    // Default null = no blocked issuing country → auto-reload supported. Override to "IN"
    // to exercise the India / off_session-mandate path.
    getOrgCardCountry: vi.fn().mockResolvedValue(null),
    // Default null = org has no card PM (link-only / none) → card_country and all
    // card_* display fields resolve null. Override with a CardDisplay object to
    // exercise a saved card (e.g. { country: "US", brand: "visa", last4: "4242",
    // expMonth: 8, expYear: 2027 }).
    getOrgCardDisplay: vi.fn().mockResolvedValue(null),
    sumSucceededTopupsForCustomer: vi.fn().mockResolvedValue("0.0000000000"),
    fetchOrgCustomer: vi.fn().mockResolvedValue(buildMockCustomer()),
    sumSucceededTopupsForOrg: vi.fn().mockResolvedValue("0.0000000000"),
    hasChargeablePmForOrg: vi.fn().mockResolvedValue(true),
    getOrgCardCountryByOrg: vi.fn().mockResolvedValue(null),
    createCheckoutSession: vi.fn().mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_mock",
      session_id: "cs_mock",
    }),
    createPortalSession: vi.fn().mockResolvedValue({
      url: "https://billing.stripe.com/p/session/test_portal",
    }),
    listCustomersByMetadata: vi.fn().mockResolvedValue({
      object: "list",
      url: "/v1/customers",
      data: [],
      has_more: false,
    }),
    updateCustomer: vi.fn().mockImplementation((id: string) =>
      Promise.resolve(buildMockCustomer({ id }))
    ),
    getStats: vi.fn().mockResolvedValue({
      total_paid_cents: "0.0000000000",
      accounts_with_payment_method: 0,
      monthly_growth: [],
      weekly_growth: [],
    }),
    reloadViaInvoice: vi.fn().mockResolvedValue({
      status: "succeeded",
      payment_intent_id: "pi_mock",
    }),
  };

  vi.spyOn(ssClient, "ensureCustomer").mockImplementation(mocks.ensureCustomer);
  vi.spyOn(ssClient, "getCustomerByOrg").mockImplementation(mocks.getCustomerByOrg);
  vi.spyOn(ssClient, "createPaymentIntent").mockImplementation(mocks.createPaymentIntent);
  vi.spyOn(ssClient, "getPaymentIntent").mockImplementation(mocks.getPaymentIntent);
  vi.spyOn(ssClient, "listPaymentIntents").mockImplementation(mocks.listPaymentIntents);
  vi.spyOn(ssClient, "listPaymentMethods").mockImplementation(mocks.listPaymentMethods);
  vi.spyOn(ssClient, "hasAttachedCardPm").mockImplementation(mocks.hasAttachedCardPm);
  vi.spyOn(ssClient, "getOrgCardCountry").mockImplementation(mocks.getOrgCardCountry);
  vi.spyOn(ssClient, "getOrgCardDisplay").mockImplementation(mocks.getOrgCardDisplay);
  vi.spyOn(ssClient, "sumSucceededTopupsForCustomer").mockImplementation(
    mocks.sumSucceededTopupsForCustomer
  );
  vi.spyOn(ssClient, "fetchOrgCustomer").mockImplementation(mocks.fetchOrgCustomer);
  vi.spyOn(ssClient, "sumSucceededTopupsForOrg").mockImplementation(
    mocks.sumSucceededTopupsForOrg
  );
  vi.spyOn(ssClient, "hasChargeablePmForOrg").mockImplementation(mocks.hasChargeablePmForOrg);
  vi.spyOn(ssClient, "getOrgCardCountryByOrg").mockImplementation(mocks.getOrgCardCountryByOrg);
  vi.spyOn(ssClient, "createCheckoutSession").mockImplementation(mocks.createCheckoutSession);
  vi.spyOn(ssClient, "createPortalSession").mockImplementation(mocks.createPortalSession);
  vi.spyOn(ssClient, "listCustomersByMetadata").mockImplementation(mocks.listCustomersByMetadata);
  vi.spyOn(ssClient, "updateCustomer").mockImplementation(mocks.updateCustomer);
  vi.spyOn(ssClient, "getStats").mockImplementation(mocks.getStats);
  vi.spyOn(reload, "reloadViaInvoice").mockImplementation(mocks.reloadViaInvoice);

  return mocks;
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

/**
 * Helper: build a customer with no payment method (default mock state).
 */
export function customerWithoutPM(overrides: Partial<ssClient.StripeCustomer> = {}): ssClient.StripeCustomer {
  return buildMockCustomer(overrides);
}
