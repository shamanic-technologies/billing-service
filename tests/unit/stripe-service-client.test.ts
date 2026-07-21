import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sumSucceededTopupsForCustomer,
  hasAttachedCardPm,
  getOrgCardCountry,
  getOrgCardCountryByOrg,
  getOrgCardDisplay,
  isAutoReloadBlockedCountry,
  type StripePaymentIntent,
  type StripePaymentIntentList,
  type StripePaymentMethod,
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

describe("hasAttachedCardPm", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pmListBody(data: StripePaymentMethod[]) {
    return { object: "list", url: "/v1/payment_methods", data, has_more: false };
  }

  it("returns true when a card payment method is attached", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(pmListBody([{ id: "pm_1", object: "payment_method", type: "card" }]))
    );

    expect(await hasAttachedCardPm({}, "cus_test")).toBe(true);
  });

  it("returns true when only a link PM is attached (no card) — Link is chargeable off_session", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        jsonResponse(
          url.includes("type=card")
            ? pmListBody([])
            : pmListBody([{ id: "pm_link", object: "payment_method", type: "link" }])
        )
      )
    );

    expect(await hasAttachedCardPm({}, "cus_test")).toBe(true);
  });

  it("returns false when neither a card nor a link PM is attached", async () => {
    // Fresh Response per call — both card and link queries read a body.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(pmListBody([]))));

    expect(await hasAttachedCardPm({}, "cus_test")).toBe(false);
  });

  it("queries card first, then link as fallback, scoped to the customer", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(pmListBody([]))));

    await hasAttachedCardPm({}, "cus_test");

    const cardUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(cardUrl).toContain("/v1/payment_methods");
    expect(cardUrl).toContain("customer=cus_test");
    expect(cardUrl).toContain("type=card");

    const linkUrl = fetchMock.mock.calls[1]?.[0] as string;
    expect(linkUrl).toContain("customer=cus_test");
    expect(linkUrl).toContain("type=link");
  });

  it("propagates stripe-service errors — never collapses to false (fail-loud)", async () => {
    fetchMock.mockResolvedValue(
      new Response("not found", { status: 404, headers: { "content-type": "text/plain" } })
    );

    await expect(hasAttachedCardPm({}, "cus_test")).rejects.toThrow(
      /stripe-service GET \/v1\/payment_methods.*failed: 404/
    );
  });
});

describe("isAutoReloadBlockedCountry", () => {
  it("blocks India (case-insensitive)", () => {
    expect(isAutoReloadBlockedCountry("IN")).toBe(true);
    expect(isAutoReloadBlockedCountry("in")).toBe(true);
  });

  it("does not block US / EEA / null / undefined", () => {
    expect(isAutoReloadBlockedCountry("US")).toBe(false);
    expect(isAutoReloadBlockedCountry("FR")).toBe(false);
    expect(isAutoReloadBlockedCountry(null)).toBe(false);
    expect(isAutoReloadBlockedCountry(undefined)).toBe(false);
  });
});

describe("getOrgCardCountry / getOrgCardCountryByOrg", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pmListBody(data: StripePaymentMethod[]) {
    return { object: "list", url: "/v1/payment_methods", data, has_more: false };
  }

  it("returns the first card PM's issuing country (real-user path)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        pmListBody([{ id: "pm_1", object: "payment_method", type: "card", card: { country: "IN" } }])
      )
    );

    expect(await getOrgCardCountry({}, "cus_test")).toBe("IN");
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("type=card");
    expect(url).toContain("customer=cus_test");
  });

  it("returns null when no card PM is attached", async () => {
    fetchMock.mockResolvedValue(jsonResponse(pmListBody([])));
    expect(await getOrgCardCountry({}, "cus_test")).toBeNull();
  });

  it("returns null when the card object carries no country", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(pmListBody([{ id: "pm_1", object: "payment_method", type: "card" }]))
    );
    expect(await getOrgCardCountry({}, "cus_test")).toBeNull();
  });

  it("by-org variant hits the user-less /internal route with type=card", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        pmListBody([{ id: "pm_1", object: "payment_method", type: "card", card: { country: "US" } }])
      )
    );

    expect(await getOrgCardCountryByOrg("org-123")).toBe("US");
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("/internal/payment_methods/by-org/org-123");
    expect(url).toContain("type=card");
  });

  it("propagates stripe-service errors (fail-loud)", async () => {
    fetchMock.mockResolvedValue(
      new Response("boom", { status: 500, headers: { "content-type": "text/plain" } })
    );
    await expect(getOrgCardCountry({}, "cus_test")).rejects.toThrow(/failed: 500/);
  });
});

describe("getOrgCardDisplay", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pmListBody(data: StripePaymentMethod[]) {
    return { object: "list", url: "/v1/payment_methods", data, has_more: false };
  }

  it("returns the first card PM's display attributes (brand, last4, expiry, country)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        pmListBody([
          {
            id: "pm_1",
            object: "payment_method",
            type: "card",
            card: { country: "US", brand: "visa", last4: "4242", exp_month: 8, exp_year: 2027 },
          },
        ])
      )
    );

    expect(await getOrgCardDisplay({}, "cus_test")).toEqual({
      country: "US",
      brand: "visa",
      last4: "4242",
      expMonth: 8,
      expYear: 2027,
    });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("type=card");
    expect(url).toContain("customer=cus_test");
  });

  it("returns null when no card PM is attached (no fabrication)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(pmListBody([])));
    expect(await getOrgCardDisplay({}, "cus_test")).toBeNull();
  });

  it("nulls individual attributes the Stripe card object omits", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(pmListBody([{ id: "pm_1", object: "payment_method", type: "card", card: { last4: "1111" } }]))
    );
    expect(await getOrgCardDisplay({}, "cus_test")).toEqual({
      country: null,
      brand: null,
      last4: "1111",
      expMonth: null,
      expYear: null,
    });
  });

  it("propagates stripe-service errors (fail-loud)", async () => {
    fetchMock.mockResolvedValue(
      new Response("boom", { status: 500, headers: { "content-type": "text/plain" } })
    );
    await expect(getOrgCardDisplay({}, "cus_test")).rejects.toThrow(/failed: 500/);
  });
});
