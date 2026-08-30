import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as ssClient from "../../src/lib/stripe-service-client.js";
import { reloadOffSession } from "../../src/lib/reload.js";

const ORG_ID = "org_test";
const IDEMPOTENCY_KEY = "ik_test_123";

function buildCharge(
  overrides: Partial<ssClient.ChargeResult> = {}
): ssClient.ChargeResult {
  return {
    object: "charge_result",
    org_id: ORG_ID,
    acquirer: "stripe",
    reference: "ch_mock",
    status: "succeeded",
    amount: 2500,
    currency: "usd",
    hosted_document_url: "https://invoice.example/in_mock",
    ...overrides,
  };
}

describe("reloadOffSession", () => {
  let chargeOrgOffSession: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    chargeOrgOffSession = vi
      .spyOn(ssClient, "chargeOrgOffSession")
      .mockResolvedValue(buildCharge());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks for a charge by org, naming an amount and a reason and no acquirer", async () => {
    await reloadOffSession(ORG_ID, 2500, IDEMPOTENCY_KEY);

    expect(chargeOrgOffSession).toHaveBeenCalledTimes(1);
    const [orgId, body] = chargeOrgOffSession.mock.calls[0]!;
    expect(orgId).toBe(ORG_ID);
    expect(body).toEqual({
      amount: 2500,
      currency: "usd",
      description: "Distribute credit top-up",
      metadata: undefined,
    });
  });

  it("succeeds for an org whose acquirer produces a hosted document", async () => {
    chargeOrgOffSession.mockResolvedValue(
      buildCharge({
        reference: "in_stripe",
        hosted_document_url: "https://invoice.stripe.com/i/in_stripe",
      })
    );

    const result = await reloadOffSession(ORG_ID, 2500, IDEMPOTENCY_KEY);

    expect(result).toEqual({ status: "succeeded", reference: "in_stripe" });
  });

  it("succeeds for an org whose acquirer has NO hosted document — absence is not failure", async () => {
    chargeOrgOffSession.mockResolvedValue(
      buildCharge({
        acquirer: "some-other-acquirer",
        reference: "ord_1",
        hosted_document_url: null,
      })
    );

    const result = await reloadOffSession(ORG_ID, 2500, IDEMPOTENCY_KEY);

    expect(result).toEqual({ status: "succeeded", reference: "ord_1" });
  });

  it("reports a failed charge as failed", async () => {
    chargeOrgOffSession.mockResolvedValue(
      buildCharge({ status: "failed", reference: "ord_dead" })
    );

    const result = await reloadOffSession(ORG_ID, 2500, IDEMPOTENCY_KEY);

    expect(result).toMatchObject({ status: "failed", reference: "ord_dead" });
    expect(result.failure_reason).toContain("failed");
  });

  it("propagates a declined charge (fail loud, no swallowed error)", async () => {
    chargeOrgOffSession.mockRejectedValue(new Error("card_declined"));

    await expect(reloadOffSession(ORG_ID, 2500, IDEMPOTENCY_KEY)).rejects.toThrow(
      /card_declined/
    );
  });

  it("throws when no org is named (no charge attempted)", async () => {
    await expect(reloadOffSession("", 2500, IDEMPOTENCY_KEY)).rejects.toThrow(
      /orgId is required/
    );
    expect(chargeOrgOffSession).not.toHaveBeenCalled();
  });

  it("forwards the idempotency key unchanged, so a retried top-up cannot double-charge", async () => {
    await reloadOffSession(ORG_ID, 2500, IDEMPOTENCY_KEY);

    const [, , forwardedKey] = chargeOrgOffSession.mock.calls[0]!;
    expect(forwardedKey).toBe(IDEMPOTENCY_KEY);
  });

  it("forwards caller metadata", async () => {
    await reloadOffSession(ORG_ID, 2500, IDEMPOTENCY_KEY, {
      reason: "month_end_sweep",
      month: "2026-07",
    });

    const [, body] = chargeOrgOffSession.mock.calls[0]!;
    expect(body.metadata).toEqual({ reason: "month_end_sweep", month: "2026-07" });
  });

  it("resolves no payment method itself — which card to charge is the acquirer's business", async () => {
    const listPaymentMethods = vi.spyOn(ssClient, "listPaymentMethods");
    const getCustomerByOrg = vi.spyOn(ssClient, "getCustomerByOrg");

    await reloadOffSession(ORG_ID, 2500, IDEMPOTENCY_KEY);

    expect(listPaymentMethods).not.toHaveBeenCalled();
    expect(getCustomerByOrg).not.toHaveBeenCalled();
    const [, body] = chargeOrgOffSession.mock.calls[0]!;
    expect(body).not.toHaveProperty("payment_method");
  });
});
