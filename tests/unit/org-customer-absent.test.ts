import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  fetchOrgCustomerOrNull,
  fetchOrgCustomer,
  getCustomerByOrgOrNull,
} from "../../src/lib/stripe-service-client.js";

/**
 * "This org has no Stripe customer" and "we could not ask stripe-service" are
 * different answers, and only the first may ever read as "no customer".
 *
 * A 404 on `/internal/customers/by-org/{orgId}` is stripe-service's definite
 * none. Anything else is an outage, and swallowing it would answer "no card, no
 * payments, no credit line" on every balance composition in the fleet.
 */
describe("reading an org's Stripe customer when it may not have one", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function res(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("404 → null (the org has no customer)", async () => {
    fetchMock.mockResolvedValue(res(404, { error: "Customer not found" }));

    expect(await fetchOrgCustomerOrNull("org-1")).toBeNull();
  });

  it("200 → the customer object verbatim", async () => {
    fetchMock.mockResolvedValue(
      res(200, {
        id: "cus_1",
        object: "customer",
        email: "founder@acme.test",
        metadata: {},
        invoice_settings: { default_payment_method: null },
      })
    );

    const customer = await fetchOrgCustomerOrNull("org-1");
    expect(customer?.id).toBe("cus_1");
    expect(customer?.email).toBe("founder@acme.test");
  });

  it.each([500, 502, 503, 401, 429])(
    "%d → THROWS; a stripe-service we could not ask is never an absent customer",
    async (status) => {
      fetchMock.mockResolvedValue(res(status, { error: "upstream" }));

      await expect(fetchOrgCustomerOrNull("org-1")).rejects.toThrow(String(status));
    }
  );

  it("fetchOrgCustomer still throws for an org with no customer", async () => {
    fetchMock.mockResolvedValue(res(404, { error: "Customer not found" }));

    await expect(fetchOrgCustomer("org-1")).rejects.toThrow(/no customer for org org-1/);
  });

  it("the org-implicit LIST read answers null on an empty list, and throws on an error", async () => {
    fetchMock.mockResolvedValue(
      res(200, { object: "list", url: "/v1/customers", data: [], has_more: false })
    );
    expect(await getCustomerByOrgOrNull({ "x-org-id": "org-1" })).toBeNull();

    fetchMock.mockResolvedValue(res(503, { error: "upstream" }));
    await expect(getCustomerByOrgOrNull({ "x-org-id": "org-1" })).rejects.toThrow("503");
  });
});
