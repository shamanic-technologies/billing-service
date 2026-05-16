import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sumSucceededTopupsForCustomer,
  type StripePaymentIntent,
  type StripePaymentIntentList,
} from "../../src/lib/stripe-service-client.js";

function pi(
  id: string,
  status: StripePaymentIntent["status"],
  amount_received: number | null
): StripePaymentIntent {
  return {
    id,
    object: "payment_intent",
    amount: amount_received ?? 0,
    amount_received,
    currency: "usd",
    customer: "cus_test",
    status,
    last_payment_error: null,
  };
}

function pageBody(data: StripePaymentIntent[], has_more: boolean): StripePaymentIntentList {
  return {
    object: "list",
    url: "/v1/payment_intents",
    data,
    has_more,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("sumSucceededTopupsForCustomer", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 0 when no payment intents exist", async () => {
    fetchMock.mockResolvedValue(jsonResponse(pageBody([], false)));

    const total = await sumSucceededTopupsForCustomer({}, "cus_test");

    expect(total).toBe("0.0000000000");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sums only succeeded payment intents with numeric amount_received", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        pageBody(
          [
            pi("pi_1", "succeeded", 2500),
            pi("pi_2", "requires_payment_method", 0),
            pi("pi_3", "succeeded", 3000),
            pi("pi_4", "canceled", null),
            pi("pi_5", "succeeded", null),
            pi("pi_6", "succeeded", 1750),
          ],
          false
        )
      )
    );

    const total = await sumSucceededTopupsForCustomer({}, "cus_test");

    expect(total).toBe("7250.0000000000");
  });

  it("paginates with starting_after when has_more=true", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          pageBody(
            [pi("pi_p1_1", "succeeded", 1000), pi("pi_p1_2", "succeeded", 2000)],
            true
          )
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(pageBody([pi("pi_p2_1", "succeeded", 500)], false))
      );

    const total = await sumSucceededTopupsForCustomer({}, "cus_test");

    expect(total).toBe("3500.0000000000");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondUrl = fetchMock.mock.calls[1]?.[0] as string;
    expect(secondUrl).toContain("starting_after=pi_p1_2");
    expect(secondUrl).toContain("customer=cus_test");
  });

  it("throws when has_more=true is paired with an empty page", async () => {
    fetchMock.mockResolvedValue(jsonResponse(pageBody([], true)));

    await expect(sumSucceededTopupsForCustomer({}, "cus_test")).rejects.toThrow(
      "has_more=true with empty page"
    );
  });

  it("throws when pagination exceeds the safety cap", async () => {
    let id = 0;
    fetchMock.mockImplementation(async () => {
      id += 1;
      return jsonResponse(pageBody([pi(`pi_${id}`, "succeeded", 1)], true));
    });

    await expect(sumSucceededTopupsForCustomer({}, "cus_test")).rejects.toThrow(
      /pagination exceeded \d+ pages/
    );
  });

  it("propagates stripe-service errors (fail-loud)", async () => {
    fetchMock.mockResolvedValue(
      new Response("oops", { status: 500, headers: { "content-type": "text/plain" } })
    );

    await expect(sumSucceededTopupsForCustomer({}, "cus_test")).rejects.toThrow(
      /stripe-service GET \/v1\/payment_intents.*failed: 500/
    );
  });

  it("preserves fractional precision when amount_received is integer cents", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        pageBody(
          [pi("pi_1", "succeeded", 55000), pi("pi_2", "succeeded", 200)],
          false
        )
      )
    );

    const total = await sumSucceededTopupsForCustomer({}, "cus_test");

    expect(total).toBe("55200.0000000000");
  });
});
