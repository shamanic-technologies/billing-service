import { describe, expect, it } from "vitest";
import { composeAbsorbedCosts } from "../../src/lib/absorbed-costs.js";

const A = "11111111-1111-1111-1111-111111111111"; // paying customer
const B = "22222222-2222-2222-2222-222222222222"; // never-paid signup
const P = "33333333-3333-3333-3333-333333333333"; // our own platform org
const C = "44444444-4444-4444-4444-444444444444"; // account with no absorbed cost

function inputs() {
  return {
    spend: [
      { orgId: A, month: "2026-08", noCampaignCents: "100", campaignCents: "5000" },
      { orgId: A, month: "2026-10", noCampaignCents: "300", campaignCents: "2000" },
      { orgId: B, month: "2026-10", noCampaignCents: "250", campaignCents: "0" },
      { orgId: P, month: "2026-10", noCampaignCents: "99999", campaignCents: "0" },
    ],
    fees: [
      { orgId: A, month: "2026-10", currency: "usd", feeCents: "60" },
      { orgId: A, month: "2026-07", currency: "eur", feeCents: "33" },
      { orgId: null, month: "2026-10", currency: "usd", feeCents: "40" },
    ],
    accounts: [
      { orgId: A, createdAt: new Date("2026-08-02T00:00:00Z"), paymentMode: "postpaid", freeCreditOffer: "legacy" },
      { orgId: B, createdAt: new Date("2026-10-05T00:00:00Z"), paymentMode: "prepaid", freeCreditOffer: "match_100" },
      { orgId: C, createdAt: new Date("2026-09-05T00:00:00Z"), paymentMode: "postpaid", freeCreditOffer: "match_100" },
      { orgId: P, createdAt: new Date("2026-02-01T00:00:00Z"), paymentMode: "postpaid", freeCreditOffer: "legacy" },
    ],
    platformOrgIds: new Set([P]),
    cashPaidCents: new Map<string, string | null>([[A, "20000"], [B, "0"], [C, null], [P, "0"]]),
    identities: new Map(),
    now: new Date("2026-10-13T15:00:00Z"),
  };
}

describe("composeAbsorbedCosts", () => {
  it("serves every month since inception, with fleet totals, averages and the since-inception line", () => {
    const out = composeAbsorbedCosts(inputs());
    expect(out.months).toEqual(["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    // Platform org kept out: A (100 + 300 + 60) + B 250 = 710.
    expect(out.fleet.absorbedCents).toBe("710.0000000000");
    expect(out.fleet.cardFeesCents).toBe("60.0000000000");
    expect(out.fleet.unattributedCardFeesCents).toBe("40.0000000000");
    expect(out.fleet.customers).toBe(3);
    expect(out.fleet.customersWithAbsorbedCost).toBe(2);
    expect(out.fleet.averagePerCustomerWithCostCents).toBe("355.0000000000");
    expect(out.fleet.paying.absorbedCents).toBe("460.0000000000");
    expect(out.fleet.neverPaid.absorbedCents).toBe("250.0000000000");
    expect(out.fleet.payingUnknown).toBe(1);

    const aug = out.fleetByMonth.find((m) => m.month === "2026-08")!;
    expect(aug.absorbedCents).toBe("100.0000000000");
    expect(aug.averagePerCustomerSinceInceptionCents).toBe("100.0000000000");
    const oct = out.fleetByMonth.find((m) => m.month === "2026-10")!;
    expect(oct.absorbedCents).toBe("610.0000000000");
    expect(oct.customersWithAbsorbedCost).toBe(2);
    expect(oct.averagePerCustomerCents).toBe("305.0000000000");
    expect(oct.cumulativeAbsorbedCents).toBe("710.0000000000");
    expect(oct.averagePerCustomerSinceInceptionCents).toBe("355.0000000000");
    expect(oct.unattributedCardFeesCents).toBe("40.0000000000");
    // The line adds up to the snapshot.
    const sum = out.fleetByMonth.reduce((s, m) => s + Number(m.absorbedCents), 0);
    expect(sum).toBe(710);
  });

  it("buckets every customer, tells paying from never-paid, and lists our own org apart", () => {
    const out = composeAbsorbedCosts(inputs());
    const byLabel = Object.fromEntries(out.distribution.map((b) => [b.label, b]));
    expect(byLabel["$0"].customers).toBe(1); // C
    expect(byLabel["$1 to $5"].customers).toBe(2); // A $4.60, B $2.50
    expect(byLabel["$1 to $5"].paying).toBe(1);
    expect(byLabel["$1 to $5"].neverPaid).toBe(1);
    expect(out.distribution.reduce((s, b) => s + b.customers, 0)).toBe(3);

    const a = out.customers.find((c) => c.orgId === A)!;
    expect(a.paying).toBe(true);
    expect(a.absorbedCents).toBe("460.0000000000");
    expect(a.byMonth.map((m) => m.month)).toEqual(["2026-07", "2026-08", "2026-10"]);
    // A EUR fee is served apart, never in the USD figures.
    expect(a.cardFeesOtherCurrencies).toEqual([{ currency: "eur", feeCents: "33.0000000000" }]);
    expect(out.fleet.cardFeesOtherCurrencies).toEqual([{ currency: "eur", feeCents: "33.0000000000" }]);
    expect(out.customers.find((c) => c.orgId === C)!.paying).toBeNull();
    expect(out.customers.find((c) => c.orgId === P)!.platformOrg).toBe(true);
  });
});
