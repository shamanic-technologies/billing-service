import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchOrgPaymentFacts } from "../../src/lib/stripe-service-client.js";

/**
 * MON-PAGE-SPEED-2-1112: the balance reads stripe-service ONCE. Each part of the answer is
 * derived exactly as the single-purpose readers derive it (fetchOrgCustomerOrNull,
 * sumSucceededTopupsForOrg, hasChargeablePmForOrg, getOrgCardCountryByOrg/DisplayByOrg).
 */
const ORG = "00000000-0000-4000-8000-00000000fa01";
const list = (data: unknown[]) => ({ object: "list", url: "/v1/payment_methods", data, has_more: false });
const summary = (nets: number[]) => ({
  object: "payment_summary",
  org_id: ORG,
  customer: null,
  as_of: null,
  totals: nets.map((n, i) => ({
    currency: i ? "eur" : "usd",
    amount_received: n,
    amount_refunded: 0,
    amount_disputed_lost: 0,
    amount_returned: 0,
    amount_net: n,
  })),
});

function answer(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchOrgPaymentFacts", () => {
  it("one request; the customer, the paid sum over every currency, the first card", async () => {
    const fetchMock = answer({
      object: "org_payment_facts",
      org_id: ORG,
      customer: { id: "cus_1", object: "customer", email: "a@b.co", metadata: {}, invoice_settings: null },
      payment_summary: summary([5000, 1234]),
      payment_methods: {
        card: list([{ id: "pm_1", type: "card", card: { country: "IN", brand: "visa", last4: "4242", exp_month: 8, exp_year: 2030 } }]),
        link: list([]),
      },
    });
    const facts = await fetchOrgPaymentFacts(ORG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain(`/internal/payment_facts/by-org/${ORG}`);
    expect(facts).toEqual({
      customer: { id: "cus_1", object: "customer", email: "a@b.co", metadata: {}, invoice_settings: null },
      paidTopupsCents: "6234.0000000000",
      hasChargeablePm: true,
      cardCountry: "IN",
      cardDisplay: { country: "IN", brand: "visa", last4: "4242", expMonth: 8, expYear: 2030 },
    });
  });

  it("no card but a link: chargeable, no card facts", async () => {
    answer({
      object: "org_payment_facts",
      customer: null,
      payment_summary: summary([]),
      payment_methods: { card: list([]), link: list([{ id: "pm_l", type: "link" }]) },
    });
    const facts = await fetchOrgPaymentFacts(ORG);
    expect(facts).toMatchObject({ customer: null, paidTopupsCents: "0.0000000000", hasChargeablePm: true, cardCountry: null, cardDisplay: null });
  });

  it("no customer on the acquirer (card null): no chargeable method, even if link answered", async () => {
    answer({
      object: "org_payment_facts",
      customer: null,
      payment_summary: summary([]),
      payment_methods: { card: null, link: list([{ id: "pm_l", type: "link" }]) },
    });
    expect((await fetchOrgPaymentFacts(ORG)).hasChargeablePm).toBe(false);
  });

  it("fails loud: a non-2xx, a missing part, or a total without amount_net", async () => {
    answer({ error: "down" }, 502);
    await expect(fetchOrgPaymentFacts(ORG)).rejects.toThrow("502");
    answer({ object: "org_payment_facts", customer: null, payment_summary: summary([]), payment_methods: { card: null } });
    await expect(fetchOrgPaymentFacts(ORG)).rejects.toThrow("unusable shape");
    answer({
      object: "org_payment_facts",
      customer: null,
      payment_summary: { ...summary([]), totals: [{ currency: "usd" }] },
      payment_methods: { card: null, link: null },
    });
    await expect(fetchOrgPaymentFacts(ORG)).rejects.toThrow("amount_net");
  });
});
