import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as ssClient from "../../src/lib/stripe-service-client.js";
import { reloadViaInvoice } from "../../src/lib/reload.js";

const CUSTOMER_ID = "cus_mock";
const ORG_ID = "org_test";
const IDEMPOTENCY_KEY = "ik_test_123";

function buildCustomer(): ssClient.StripeCustomer {
  return {
    id: CUSTOMER_ID,
    object: "customer",
    email: null,
    metadata: {},
    invoice_settings: { default_payment_method: "pm_link_default" },
  };
}

function buildPM(id: string, type: string): ssClient.StripePaymentMethod {
  return { id, object: "payment_method", type };
}

function buildPMList(data: ssClient.StripePaymentMethod[]): ssClient.StripePaymentMethodList {
  return { object: "list", url: "/v1/payment_methods", data, has_more: false };
}

function buildInvoice(
  status: string | null,
  payment_intent: ssClient.StripeInvoice["payment_intent"] = "pi_mock"
): ssClient.StripeInvoice {
  return {
    id: "in_mock",
    object: "invoice",
    status,
    paid: status === "paid",
    amount_paid: 2500,
    currency: "usd",
    payment_intent,
  };
}

describe("reloadViaInvoice", () => {
  let getCustomerByOrg: ReturnType<typeof vi.spyOn>;
  let listPaymentMethods: ReturnType<typeof vi.spyOn>;
  let createOffSessionInvoiceForOrg: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getCustomerByOrg = vi
      .spyOn(ssClient, "getCustomerByOrg")
      .mockResolvedValue(buildCustomer());
    listPaymentMethods = vi.spyOn(ssClient, "listPaymentMethods");
    createOffSessionInvoiceForOrg = vi
      .spyOn(ssClient, "createOffSessionInvoiceForOrg")
      .mockResolvedValue(buildInvoice("paid", "pi_mock"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("picks card over link in a mixed PM list", async () => {
    listPaymentMethods.mockResolvedValue(
      buildPMList([buildPM("pm_card_1", "card"), buildPM("pm_link_1", "link")])
    );

    await reloadViaInvoice({ "x-org-id": ORG_ID }, 2500, IDEMPOTENCY_KEY);

    expect(createOffSessionInvoiceForOrg).toHaveBeenCalledTimes(1);
    const [orgId, body] = createOffSessionInvoiceForOrg.mock.calls[0]!;
    expect(orgId).toBe(ORG_ID);
    expect(body).toMatchObject({
      amount: 2500,
      currency: "usd",
      description: "Distribute credit top-up",
      payment_method: "pm_card_1",
    });
  });

  it("picks the only card when the list has a single entry", async () => {
    listPaymentMethods.mockResolvedValue(
      buildPMList([buildPM("pm_card_only", "card")])
    );

    await reloadViaInvoice({ "x-org-id": ORG_ID }, 1000, IDEMPOTENCY_KEY);

    const [, body] = createOffSessionInvoiceForOrg.mock.calls[0]!;
    expect(body.payment_method).toBe("pm_card_only");
  });

  it("throws when no card AND no link PM is attached (no silent default-PM fallback)", async () => {
    listPaymentMethods.mockResolvedValue(buildPMList([]));

    await expect(
      reloadViaInvoice({ "x-org-id": ORG_ID }, 2500, IDEMPOTENCY_KEY)
    ).rejects.toThrow(/no chargeable payment_method \(card or link\)/);
    expect(createOffSessionInvoiceForOrg).not.toHaveBeenCalled();
  });

  it("falls back to a link PM when the customer has no card (Link-only org)", async () => {
    // Card query → empty; link query → one link PM. Stripe charges link off_session.
    listPaymentMethods.mockImplementation((_identity: unknown, query: { type?: string }) =>
      Promise.resolve(
        query.type === "card"
          ? buildPMList([])
          : buildPMList([buildPM("pm_link_only", "link")])
      )
    );

    await reloadViaInvoice({ "x-org-id": ORG_ID }, 2500, IDEMPOTENCY_KEY);

    expect(listPaymentMethods).toHaveBeenCalledTimes(2);
    const [, body] = createOffSessionInvoiceForOrg.mock.calls[0]!;
    expect(body.payment_method).toBe("pm_link_only");
  });

  it("throws when identity is missing x-org-id (no charge attempted)", async () => {
    await expect(
      reloadViaInvoice({}, 2500, IDEMPOTENCY_KEY)
    ).rejects.toThrow(/missing x-org-id/);
    expect(getCustomerByOrg).not.toHaveBeenCalled();
    expect(createOffSessionInvoiceForOrg).not.toHaveBeenCalled();
  });

  it("flattens a paid invoice to {status:succeeded, payment_intent_id}", async () => {
    listPaymentMethods.mockResolvedValue(buildPMList([buildPM("pm_card", "card")]));
    createOffSessionInvoiceForOrg.mockResolvedValue(buildInvoice("paid", "pi_xyz"));

    const result = await reloadViaInvoice({ "x-org-id": ORG_ID }, 2500, IDEMPOTENCY_KEY);

    expect(result).toEqual({ status: "succeeded", payment_intent_id: "pi_xyz" });
  });

  it("reads payment_intent from an expanded invoice.payment_intent object", async () => {
    listPaymentMethods.mockResolvedValue(buildPMList([buildPM("pm_card", "card")]));
    createOffSessionInvoiceForOrg.mockResolvedValue(buildInvoice("paid", { id: "pi_expanded" }));

    const result = await reloadViaInvoice({ "x-org-id": ORG_ID }, 2500, IDEMPOTENCY_KEY);

    expect(result).toEqual({ status: "succeeded", payment_intent_id: "pi_expanded" });
  });

  it("forwards the idempotency key unchanged to the invoice endpoint", async () => {
    listPaymentMethods.mockResolvedValue(buildPMList([buildPM("pm_card", "card")]));

    await reloadViaInvoice({ "x-org-id": ORG_ID }, 2500, IDEMPOTENCY_KEY);

    const [, , forwardedKey] = createOffSessionInvoiceForOrg.mock.calls[0]!;
    expect(forwardedKey).toBe(IDEMPOTENCY_KEY);
  });

  it("forwards caller metadata to the invoice endpoint", async () => {
    listPaymentMethods.mockResolvedValue(buildPMList([buildPM("pm_card", "card")]));

    await reloadViaInvoice({ "x-org-id": ORG_ID }, 2500, IDEMPOTENCY_KEY, {
      reason: "month_end_sweep",
      month: "2026-07",
    });

    const [, body] = createOffSessionInvoiceForOrg.mock.calls[0]!;
    expect(body.metadata).toEqual({ reason: "month_end_sweep", month: "2026-07" });
  });

  it("queries listPaymentMethods with customer id and type=card", async () => {
    listPaymentMethods.mockResolvedValue(buildPMList([buildPM("pm_card", "card")]));

    await reloadViaInvoice({ "x-org-id": ORG_ID }, 2500, IDEMPOTENCY_KEY);

    expect(getCustomerByOrg).toHaveBeenCalledTimes(1);
    expect(listPaymentMethods).toHaveBeenCalledTimes(1);
    const [, query] = listPaymentMethods.mock.calls[0]!;
    expect(query).toEqual({ customer: CUSTOMER_ID, type: "card" });
  });
});
