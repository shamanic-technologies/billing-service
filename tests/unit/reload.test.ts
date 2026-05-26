import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as ssClient from "../../src/lib/stripe-service-client.js";
import { reloadViaPaymentIntent } from "../../src/lib/reload.js";

const CUSTOMER_ID = "cus_mock";
const IDEMPOTENCY_KEY = "ik_test_123";

function buildCustomer(): ssClient.StripeCustomer {
  return {
    id: CUSTOMER_ID,
    object: "customer",
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

function buildPI(
  id: string,
  status: ssClient.StripePaymentIntent["status"],
  amount_received: number | null = null
): ssClient.StripePaymentIntent {
  return {
    id,
    object: "payment_intent",
    amount: amount_received ?? 0,
    amount_received,
    currency: "usd",
    customer: CUSTOMER_ID,
    status,
    last_payment_error: null,
  };
}

describe("reloadViaPaymentIntent", () => {
  let getCustomerByOrg: ReturnType<typeof vi.spyOn>;
  let listPaymentMethods: ReturnType<typeof vi.spyOn>;
  let createPaymentIntent: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getCustomerByOrg = vi
      .spyOn(ssClient, "getCustomerByOrg")
      .mockResolvedValue(buildCustomer());
    listPaymentMethods = vi.spyOn(ssClient, "listPaymentMethods");
    createPaymentIntent = vi
      .spyOn(ssClient, "createPaymentIntent")
      .mockResolvedValue(buildPI("pi_mock", "succeeded", 2500));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("picks card over link in a mixed PM list", async () => {
    listPaymentMethods.mockResolvedValue(
      buildPMList([buildPM("pm_card_1", "card"), buildPM("pm_link_1", "link")])
    );

    await reloadViaPaymentIntent({ "x-org-id": "org_test" }, 2500, IDEMPOTENCY_KEY);

    expect(createPaymentIntent).toHaveBeenCalledTimes(1);
    const [, body] = createPaymentIntent.mock.calls[0]!;
    expect(body).toMatchObject({
      amount: 2500,
      currency: "usd",
      customer: CUSTOMER_ID,
      payment_method: "pm_card_1",
      confirm: true,
      off_session: true,
    });
  });

  it("picks the only card when the list has a single entry", async () => {
    listPaymentMethods.mockResolvedValue(
      buildPMList([buildPM("pm_card_only", "card")])
    );

    await reloadViaPaymentIntent({ "x-org-id": "org_test" }, 1000, IDEMPOTENCY_KEY);

    const [, body] = createPaymentIntent.mock.calls[0]!;
    expect(body.payment_method).toBe("pm_card_only");
  });

  it("throws when the PM list is empty (no silent default-PM fallback)", async () => {
    listPaymentMethods.mockResolvedValue(buildPMList([]));

    await expect(
      reloadViaPaymentIntent({ "x-org-id": "org_test" }, 2500, IDEMPOTENCY_KEY)
    ).rejects.toThrow(/no card payment_method attached/);
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it("flattens a succeeded PI to {status:succeeded, payment_intent_id}", async () => {
    listPaymentMethods.mockResolvedValue(buildPMList([buildPM("pm_card", "card")]));
    createPaymentIntent.mockResolvedValue(buildPI("pi_xyz", "succeeded", 2500));

    const result = await reloadViaPaymentIntent(
      { "x-org-id": "org_test" },
      2500,
      IDEMPOTENCY_KEY
    );

    expect(result).toEqual({ status: "succeeded", payment_intent_id: "pi_xyz" });
  });

  it("forwards the idempotency key unchanged to createPaymentIntent", async () => {
    listPaymentMethods.mockResolvedValue(buildPMList([buildPM("pm_card", "card")]));

    await reloadViaPaymentIntent({ "x-org-id": "org_test" }, 2500, IDEMPOTENCY_KEY);

    const [, , forwardedKey] = createPaymentIntent.mock.calls[0]!;
    expect(forwardedKey).toBe(IDEMPOTENCY_KEY);
  });

  it("queries listPaymentMethods with customer id and type=card", async () => {
    listPaymentMethods.mockResolvedValue(buildPMList([buildPM("pm_card", "card")]));

    await reloadViaPaymentIntent({ "x-org-id": "org_test" }, 2500, IDEMPOTENCY_KEY);

    expect(getCustomerByOrg).toHaveBeenCalledTimes(1);
    expect(listPaymentMethods).toHaveBeenCalledTimes(1);
    const [, query] = listPaymentMethods.mock.calls[0]!;
    expect(query).toEqual({ customer: CUSTOMER_ID, type: "card" });
  });
});
