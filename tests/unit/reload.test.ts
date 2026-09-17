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

/**
 * A refusal now arrives as a COMPLETED request carrying the acquirer's own
 * reason (stripe-service v0.51.1), not as a throw. Own describe block, own
 * file-level fixture — see the parent block's mock setup.
 */
describe("reloadOffSession on a refused card", () => {
  let chargeOrgOffSession: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    chargeOrgOffSession = vi.spyOn(ssClient, "chargeOrgOffSession");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the reason the bank gave", async () => {
    chargeOrgOffSession.mockResolvedValue(
      buildCharge({
        status: "failed",
        reference: "pi_declined",
        hosted_document_url: null,
        failure: {
          type: "card_declined",
          code: "insufficient_funds",
          message: "Your card has insufficient funds.",
        },
      })
    );

    const result = await reloadOffSession(ORG_ID, 2500, IDEMPOTENCY_KEY);

    expect(result.status).toBe("failed");
    expect(result.reference).toBe("pi_declined");
    // "try another card" and "call your bank" are different instructions, and
    // a bare `charge.status=failed` cannot tell them apart.
    expect(result.failure_reason).toBe(
      "card_declined: insufficient_funds: Your card has insufficient funds."
    );
  });

  it("still reports a failure that names no reason", async () => {
    chargeOrgOffSession.mockResolvedValue(
      buildCharge({ status: "failed", hosted_document_url: null })
    );

    const result = await reloadOffSession(ORG_ID, 2500, IDEMPOTENCY_KEY);

    expect(result.status).toBe("failed");
    expect(result.failure_reason).toBe("charge.status=failed");
  });
});
