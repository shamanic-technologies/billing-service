import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAcquiringFeesByOrgMonth } from "../../src/lib/stripe-service-client.js";

const ORG = "11111111-1111-1111-1111-111111111111";

function respond(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

describe("fetchAcquiringFeesByOrgMonth: one USD basis", () => {
  beforeEach(() => {
    process.env.STRIPE_SERVICE_URL = "http://stripe.test";
    process.env.STRIPE_SERVICE_API_KEY = "k";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads a EUR fee in USD, and keeps only an unconvertible fee in its own currency", async () => {
    respond({
      object: "acquiring_fees_by_month",
      orgs: [
        {
          org_id: ORG,
          months: [
            { month: "2026-04", currency: "eur", stripe_fee_cents: 647, revolut_fee_cents: 0, fee_cents: 647, fee_usd_cents: 761, unconverted_fee_count: 0, unconverted_fee_cents: 0 },
            { month: "2026-10", currency: "usd", stripe_fee_cents: 301, revolut_fee_cents: 0, fee_cents: 301, fee_usd_cents: 301, unconverted_fee_count: 0, unconverted_fee_cents: 0 },
            { month: "2026-10", currency: "gbp", stripe_fee_cents: 0, revolut_fee_cents: 50, fee_cents: 50, fee_usd_cents: 0, unconverted_fee_count: 1, unconverted_fee_cents: 50 },
          ],
        },
      ],
      unattributed: { months: [] },
    });
    const rows = await fetchAcquiringFeesByOrgMonth();
    expect(rows).toEqual([
      { orgId: ORG, month: "2026-04", currency: "usd", feeCents: "761" },
      { orgId: ORG, month: "2026-10", currency: "usd", feeCents: "301" },
      { orgId: ORG, month: "2026-10", currency: "usd", feeCents: "0" },
      { orgId: ORG, month: "2026-10", currency: "gbp", feeCents: "50" },
    ]);
  });

  it("throws on a stripe-service that serves no USD figure", async () => {
    respond({
      object: "acquiring_fees_by_month",
      orgs: [{ org_id: ORG, months: [{ month: "2026-04", currency: "eur", stripe_fee_cents: 647, revolut_fee_cents: 0, fee_cents: 647 }] }],
      unattributed: { months: [] },
    });
    await expect(fetchAcquiringFeesByOrgMonth()).rejects.toThrow(/fee_usd_cents/);
  });
});

const REAL = "b645207b-d8e9-40b0-9391-072b777cd9a9";

describe("fetchOrgNames", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("never sends client-service an id it would refuse", async () => {
    process.env.CLIENT_SERVICE_URL = "http://client.test";
    process.env.CLIENT_SERVICE_API_KEY = "k";
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const ids = JSON.parse(String(init.body)).orgIds as string[];
      return new Response(JSON.stringify({ orgs: ids.map((orgId) => ({ orgId, name: "GrowthAgency.dev" })), notFound: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", f);
    const { fetchOrgNames } = await import("../../src/lib/client-service-client.js");
    const out = await fetchOrgNames([REAL, "unknown", "00000000-0000-0000-0000-000000000001"]);
    expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body)).orgIds).toEqual([REAL]);
    expect(out.get(REAL)).toBe("GrowthAgency.dev");
    expect(out.has("unknown")).toBe(false);
  });
});
