import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sumPaidTopupsForOrgAsOf,
  type StripePaymentSummary,
  type StripePaymentSummaryTotal,
} from "../../src/lib/stripe-service-client.js";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const AS_OF = 1_753_833_600; // 2026-07-30T00:00:00Z, the free-credit launch instant

function total(
  amount_received: number,
  amount_returned: number,
  currency = "usd"
): StripePaymentSummaryTotal {
  return {
    currency,
    amount_received,
    amount_refunded: amount_returned,
    amount_disputed_lost: 0,
    amount_returned,
    amount_net: amount_received - amount_returned,
  };
}

function summary(
  totals: StripePaymentSummaryTotal[],
  as_of: number | null = AS_OF
): StripePaymentSummary {
  return {
    object: "payment_summary",
    org_id: ORG,
    customer: "cus_test",
    as_of,
    totals,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("sumPaidTopupsForOrgAsOf", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks stripe-service for the bounded summary rather than filtering payments here", async () => {
    fetchMock.mockResolvedValue(jsonResponse(summary([total(20_000, 0)])));

    const paid = await sumPaidTopupsForOrgAsOf(ORG, AS_OF);

    expect(paid).toBe("20000.0000000000");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(`/internal/payment_summary/by-org/${ORG}`);
    expect(url).toContain(`as_of=${AS_OF}`);
    // User-less, org-keyed: service auth only, no invented end-user identity.
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["x-user-id"]).toBeUndefined();
    expect(headers["x-org-id"]).toBeUndefined();
  });

  it("takes the NET figure, so a return that had already happened is subtracted", async () => {
    // $200 paid, $150 of it refunded before the instant → $50 had been paid, net.
    fetchMock.mockResolvedValue(jsonResponse(summary([total(20_000, 15_000)])));

    expect(await sumPaidTopupsForOrgAsOf(ORG, AS_OF)).toBe("5000.0000000000");
  });

  it("sums every currency with activity, matching the unbounded paid-topups sum", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(summary([total(20_000, 0), total(1_000, 400, "eur")]))
    );

    expect(await sumPaidTopupsForOrgAsOf(ORG, AS_OF)).toBe("20600.0000000000");
  });

  it("reads an org with no mirrored payments as a genuine zero", async () => {
    fetchMock.mockResolvedValue(jsonResponse(summary([])));

    expect(await sumPaidTopupsForOrgAsOf(ORG, AS_OF)).toBe("0.0000000000");
  });

  it("throws when stripe-service did not apply the bound — never the all-time figure", async () => {
    // A stripe-service older than v0.33.0 ignores as_of and answers unbounded. The
    // echo is the only thing that distinguishes it, and silently taking that figure
    // would grandfather orgs out of a gift they are owed.
    fetchMock.mockResolvedValue(jsonResponse(summary([total(20_000, 0)], null)));

    await expect(sumPaidTopupsForOrgAsOf(ORG, AS_OF)).rejects.toThrow(/as_of/);
  });

  it("throws when the echoed bound is a different instant", async () => {
    fetchMock.mockResolvedValue(jsonResponse(summary([total(20_000, 0)], AS_OF - 1)));

    await expect(sumPaidTopupsForOrgAsOf(ORG, AS_OF)).rejects.toThrow(/as_of/);
  });

  it("propagates a stripe-service failure — no fallback figure", async () => {
    fetchMock.mockResolvedValue(
      new Response("upstream down", { status: 502, headers: {} })
    );

    await expect(sumPaidTopupsForOrgAsOf(ORG, AS_OF)).rejects.toThrow();
  });
});
