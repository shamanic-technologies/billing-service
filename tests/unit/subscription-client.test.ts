/**
 * Pins billing's reader to stripe-service v0.56.0's subscription surface: paths,
 * bodies, the unix → ISO mapping, "none" = an empty list, and "could not ask" =
 * a throw (never an empty list).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createSubscriptionCheckout,
  fetchOrgSubscriptions,
  setSubscriptionCancelAtPeriodEnd,
  SubscriptionServiceError,
  updateSubscriptionMonthlyAmount,
} from "../../src/lib/subscription-client.js";

const orgId = "00000000-0000-0000-0000-0000000005d1";
const userId = "00000000-0000-0000-0000-0000000005d9";
const summary = {
  object: "subscription_summary",
  id: "sub_1",
  org_id: orgId,
  customer: "cus_1",
  status: "trialing",
  amount: 9900,
  currency: "usd",
  interval: "month",
  trial_start: 1790000000,
  trial_end: 1790259200,
  current_period_start: 1790000000,
  current_period_end: 1790259200,
  cancel_at_period_end: false,
  has_payment_method: true,
  created: 1790000000,
};

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("subscription client (stripe-service v0.56.0)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    process.env.STRIPE_SERVICE_URL = "http://stripe.test";
    process.env.STRIPE_SERVICE_API_KEY = "k";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads the org's subscriptions and maps unix seconds to ISO", async () => {
    fetchMock.mockResolvedValue(reply(200, { object: "list", has_subscription: true, data: [summary] }));
    const subs = await fetchOrgSubscriptions(orgId);
    expect(fetchMock.mock.calls[0][0]).toBe(`http://stripe.test/internal/subscriptions/by-org/${orgId}`);
    expect(subs).toEqual([
      {
        id: "sub_1",
        status: "trialing",
        trialEnd: new Date(1790259200 * 1000).toISOString(),
        cancelAtPeriodEnd: false,
        currentPeriodEnd: new Date(1790259200 * 1000).toISOString(),
        monthlyAmountCents: 9900,
        currency: "usd",
        hasPaymentMethod: true,
        createdAt: new Date(1790000000 * 1000).toISOString(),
      },
    ]);
  });

  it("'none' is an empty list; 'could not ask' throws", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { object: "list", has_subscription: false, data: [] }));
    expect(await fetchOrgSubscriptions(orgId)).toEqual([]);
    fetchMock.mockResolvedValueOnce(reply(502, { code: "acquirer_unavailable" }));
    await expect(fetchOrgSubscriptions(orgId)).rejects.toThrow(/502/);
  });

  it("checkout: embedded, $99, 3-day trial, payer named; returns the client_secret", async () => {
    fetchMock.mockResolvedValue(reply(200, { id: "cs_1", client_secret: "cs_1_secret", url: null }));
    const out = await createSubscriptionCheckout(orgId, {
      monthlyAmountCents: 9900,
      trialDays: 3,
      uiMode: "embedded",
      userId,
    });
    expect(out).toEqual({ sessionId: "cs_1", url: null, clientSecret: "cs_1_secret" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://stripe.test/internal/subscriptions/by-org/${orgId}/checkout`);
    expect(init.method).toBe("POST");
    expect(init.headers["x-user-id"]).toBe(userId);
    expect(JSON.parse(init.body)).toMatchObject({
      amount: 9900,
      currency: "usd",
      trial_period_days: 3,
      ui_mode: "embedded",
    });
  });

  it("a stated refusal carries its code (acquirer_not_stripe)", async () => {
    fetchMock.mockResolvedValue(reply(409, { code: "acquirer_not_stripe", acquirer: "revolut" }));
    const err = await createSubscriptionCheckout(orgId, { monthlyAmountCents: 9900, trialDays: 3, uiMode: "embedded" }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(SubscriptionServiceError);
    expect(err.code).toBe("acquirer_not_stripe");
  });

  it("amount change, cancel (POST) and resume (DELETE) hit the right paths", async () => {
    fetchMock.mockImplementation(async () => reply(200, { ...summary, status: "active" }));
    await updateSubscriptionMonthlyAmount(orgId, "sub_1", 19900);
    await setSubscriptionCancelAtPeriodEnd(orgId, "sub_1", true);
    await setSubscriptionCancelAtPeriodEnd(orgId, "sub_1", false);
    const calls = fetchMock.mock.calls.map(([u, i]) => `${i.method} ${u}`);
    expect(calls).toEqual([
      `POST http://stripe.test/internal/subscriptions/by-org/${orgId}/sub_1/amount`,
      `POST http://stripe.test/internal/subscriptions/by-org/${orgId}/sub_1/cancellation`,
      `DELETE http://stripe.test/internal/subscriptions/by-org/${orgId}/sub_1/cancellation`,
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ amount: 19900 });
  });
});
