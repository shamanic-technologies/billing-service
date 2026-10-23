import { describe, expect, it } from "vitest";
import { composeAbsorbedCosts, customerStatusOf, ownOrgReasonOf } from "../../src/lib/absorbed-costs.js";

const A = "11111111-1111-1111-1111-111111111111"; // paying customer
const B = "22222222-2222-2222-2222-222222222222"; // never-paid signup
const P = "33333333-3333-3333-3333-333333333333"; // our own platform org
const C = "44444444-4444-4444-4444-444444444444"; // account with no absorbed cost
const K = "55555555-5555-5555-5555-555555555555"; // our own working org (staff billing contact)
const X = "66666666-6666-6666-6666-666666666666"; // a deleted (torn down) test org that once paid

function inputs() {
  return {
    spend: [
      { orgId: A, month: "2026-08", noCampaignCents: "100", campaignCents: "5000" },
      { orgId: A, month: "2026-10", noCampaignCents: "300", campaignCents: "2000" },
      { orgId: B, month: "2026-10", noCampaignCents: "250", campaignCents: "0" },
      { orgId: P, month: "2026-10", noCampaignCents: "99999", campaignCents: "0" },
      { orgId: K, month: "2026-10", noCampaignCents: "3474", campaignCents: "0" },
    ],
    deletedOrgIds: new Set<string>(),
    brandTransfers: [] as Array<{ sourceOrgId: string; targetOrgId: string; brandId: string; movedUsageNetCents: string; transferredAt: Date }>,
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
    ownOrgReasons: new Map([[K, "staff_billing_contact" as const]]),
    cashPaidCents: new Map<string, string | null>([[A, "20000"], [B, "0"], [C, null], [P, "0"]]),
    orgNames: new Map<string, string | null>([[A, "Acme Inc"], [K, "GrowthAgency.dev"]]),
    activity: new Map([
      [A, { lastPaymentAt: new Date("2026-08-20T00:00:00Z"), campaignsRunning: 0 }],
      [B, { lastPaymentAt: null, campaignsRunning: 2 }],
      [C, { lastPaymentAt: undefined, campaignsRunning: null }],
    ]),
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

  it("names the org by its org name, lists our own orgs apart, and tells current from churned", () => {
    const out = composeAbsorbedCosts(inputs());
    const k = out.customers.find((c) => c.orgId === K)!;
    expect(k.orgName).toBe("GrowthAgency.dev");
    expect(k.ownOrg).toBe(true);
    expect(k.ownOrgReason).toBe("staff_billing_contact");
    expect(out.ownOrgs.map((o) => o.orgId).sort()).toEqual([P, K].sort());
    // Our org's $34.74 is in no fleet figure.
    expect(out.fleet.absorbedCents).toBe("710.0000000000");
    expect(out.distribution.reduce((s, b) => s + b.customers, 0)).toBe(3);

    const a = out.customers.find((c) => c.orgId === A)!;
    expect(a.orgName).toBe("Acme Inc");
    expect(a.orgDomain).toBeNull();
    expect(a.lastPaymentAt).toBe("2026-08-20T00:00:00.000Z");
    expect(a.daysSinceLastPayment).toBe(54);
    expect(a.customerStatus).toBe("churned");
    expect(a.current).toBe(false);
    const b = out.customers.find((c) => c.orgId === B)!;
    expect(b.customerStatus).toBe("current");
    expect(b.lastPaymentAt).toBeNull();
    expect(b.lastPaymentReadable).toBe(true);
    const c = out.customers.find((x) => x.orgId === C)!;
    expect(c.customerStatus).toBeNull();
    expect(c.lastPaymentReadable).toBe(false);
    expect(out.fleet.currentCustomers).toBe(1);
    expect(out.fleet.churnedCustomers).toBe(1);
    expect(out.fleet.customerStatusUnknown).toBe(1);
  });

  it("classifies an org as ours only from who is behind it", () => {
    expect(ownOrgReasonOf({ platformOrg: true, billingContactEmail: null, userEmails: [] })).toBe("platform_org");
    expect(ownOrgReasonOf({ platformOrg: false, billingContactEmail: "kevin.lourd@gmail.com", userEmails: ["kevin.lourd@gmail.com"] })).toBe("staff_billing_contact");
    // Staff saved the card but a client uses the org: a customer.
    expect(ownOrgReasonOf({ platformOrg: false, billingContactEmail: "kevin.lourd@gmail.com", userEmails: ["kevin+x@distribute.you", "client@acme.com"] })).toBeNull();
    expect(ownOrgReasonOf({ platformOrg: false, billingContactEmail: "client@acme.com", userEmails: [] })).toBeNull();
    expect(customerStatusOf({ lastPaymentAt: undefined, campaignsRunning: 1 })).toBe("current");
    expect(customerStatusOf({ lastPaymentAt: undefined, campaignsRunning: 0 })).toBeNull();
    expect(customerStatusOf({ lastPaymentAt: null, campaignsRunning: 0 })).toBe("never_paid");
  });

  it("names a staff test org as ours: no billing contact, every user staff", () => {
    expect(ownOrgReasonOf({ platformOrg: false, billingContactEmail: null, userEmails: ["kevin@distribute.you", "kevin.lourd+e2e@gmail.com"] })).toBe("staff_test_org");
    // No user at all: nobody to say it is ours.
    expect(ownOrgReasonOf({ platformOrg: false, billingContactEmail: null, userEmails: [] })).toBeNull();
    // A client among the users: a customer.
    expect(ownOrgReasonOf({ platformOrg: false, billingContactEmail: null, userEmails: ["kevin@distribute.you", "client@acme.com"] })).toBeNull();
    // A client's card on file, staff users only (agency set it up): a customer.
    expect(ownOrgReasonOf({ platformOrg: false, billingContactEmail: "client@acme.com", userEmails: ["kevin@distribute.you"] })).toBeNull();
  });

  it("keeps a deleted org out of the customers and every fleet figure, listed apart", () => {
    const inp = inputs();
    inp.fees.push({ orgId: X, month: "2026-06", currency: "usd", feeCents: "25" });
    inp.cashPaidCents.set(X, "2500");
    inp.activity.set(X, { lastPaymentAt: new Date("2026-06-17T00:00:00Z"), campaignsRunning: 0 });
    inp.deletedOrgIds.add(X);
    const out = composeAbsorbedCosts(inp);
    const x = out.customers.find((c) => c.orgId === X)!;
    expect(x.orgDeleted).toBe(true);
    expect(x.ownOrg).toBe(false);
    expect(x.customerStatus).toBeNull();
    expect(out.deletedOrgs).toEqual([{ orgId: X, cashPaidCents: "2500", lastPaymentAt: "2026-06-17T00:00:00.000Z", absorbedCents: "25.0000000000" }]);
    expect(out.fleet.absorbedCents).toBe("710.0000000000");
    expect(out.fleet.customers).toBe(3);
    expect(out.fleet.churnedCustomers).toBe(1);
    expect(out.fleetByMonth.find((m) => m.month === "2026-06")!.absorbedCents).toBe("0.0000000000");
  });

  it("states the history a brand transfer moved in, on both orgs", () => {
    const inp = inputs();
    inp.brandTransfers.push({ sourceOrgId: K, targetOrgId: A, brandId: "brand-1", movedUsageNetCents: "4000.5", transferredAt: new Date("2026-09-28T04:29:06Z") });
    const out = composeAbsorbedCosts(inp);
    const a = out.customers.find((c) => c.orgId === A)!;
    expect(a.transferredInUsageCents).toBe("4000.5000000000");
    expect(a.brandTransfersIn).toEqual([{ orgId: K, orgName: "GrowthAgency.dev", brandId: "brand-1", movedUsageNetCents: "4000.5000000000", transferredAt: "2026-09-28T04:29:06.000Z" }]);
    expect(a.transferredOutUsageCents).toBe("0.0000000000");
    const k = out.customers.find((c) => c.orgId === K)!;
    expect(k.transferredOutUsageCents).toBe("4000.5000000000");
    expect(k.brandTransfersOut[0].orgId).toBe(A);
  });
});
