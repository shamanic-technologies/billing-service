import { describe, expect, it } from "vitest";
import { foldCashByOrgDay } from "../../src/lib/cash-by-org-day.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

describe("foldCashByOrgDay", () => {
  it("adds off-platform payments on their paid UTC day, gross and net, and keeps totals = Σ rows", () => {
    const out = foldCashByOrgDay(
      {
        asOf: "2026-11-21T10:00:00.000Z",
        totalGrossCents: "15000",
        totalNetCents: "12000",
        totalAgencyGrossCents: "0",
        totalAgencyNetCents: "0",
        rows: [
          { orgId: ORG_A, day: "2026-11-01", grossCents: "10000", netCents: "10000", agencyGrossCents: "0", agencyNetCents: "0" },
          // refund of an earlier payment, dated on the refund's own day
          { orgId: ORG_A, day: "2026-11-03", grossCents: "0", netCents: "-3000", agencyGrossCents: "0", agencyNetCents: "0" },
          { orgId: null, day: "2026-11-02", grossCents: "5000", netCents: "5000", agencyGrossCents: "0", agencyNetCents: "0" },
        ],
      },
      [{ orgId: ORG_B, paidAt: new Date("2026-11-02T23:30:00Z"), amountCents: "20000.0000000000" }]
    );

    expect(out.total_gross_cents).toBe("35000.0000000000");
    expect(out.total_net_cents).toBe("32000.0000000000");
    expect(out.rows).toEqual([
      { org_id: ORG_A, day: "2026-11-01", gross_cents: "10000.0000000000", net_cents: "10000.0000000000", agency_gross_cents: "0.0000000000", agency_net_cents: "0.0000000000" },
      { org_id: null, day: "2026-11-02", gross_cents: "5000.0000000000", net_cents: "5000.0000000000", agency_gross_cents: "0.0000000000", agency_net_cents: "0.0000000000" },
      { org_id: ORG_B, day: "2026-11-02", gross_cents: "20000.0000000000", net_cents: "20000.0000000000", agency_gross_cents: "0.0000000000", agency_net_cents: "0.0000000000" },
      { org_id: ORG_A, day: "2026-11-03", gross_cents: "0.0000000000", net_cents: "-3000.0000000000", agency_gross_cents: "0.0000000000", agency_net_cents: "0.0000000000" },
    ]);
    for (const r of out.rows) expect(Number(r.net_cents)).toBeLessThanOrEqual(Number(r.gross_cents));
  });

  it("merges an off-platform payment into the org's existing stripe row of that day", () => {
    const out = foldCashByOrgDay(
      {
        asOf: "2026-11-21T10:00:00.000Z",
        totalGrossCents: "100",
        totalNetCents: "100",
        totalAgencyGrossCents: "0",
        totalAgencyNetCents: "0",
        rows: [{ orgId: ORG_A, day: "2026-11-01", grossCents: "100", netCents: "100", agencyGrossCents: "0", agencyNetCents: "0" }],
      },
      [{ orgId: ORG_A, paidAt: new Date("2026-11-01T00:00:00Z"), amountCents: "50" }]
    );
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].gross_cents).toBe("150.0000000000");
  });

  it("throws when stripe-service totals disagree with its rows", () => {
    expect(() =>
      foldCashByOrgDay(
        {
          asOf: "x",
          totalGrossCents: "101",
          totalNetCents: "100",
        totalAgencyGrossCents: "0",
        totalAgencyNetCents: "0",
          rows: [{ orgId: ORG_A, day: "2026-11-01", grossCents: "100", netCents: "100", agencyGrossCents: "0", agencyNetCents: "0" }],
        },
        []
      )
    ).toThrow(/gross/);
  });

  it("throws when a row's net is above its gross", () => {
    expect(() =>
      foldCashByOrgDay(
        {
          asOf: "x",
          totalGrossCents: "100",
          totalNetCents: "200",
        totalAgencyGrossCents: "0",
        totalAgencyNetCents: "0",
          rows: [{ orgId: ORG_A, day: "2026-11-01", grossCents: "100", netCents: "200", agencyGrossCents: "0", agencyNetCents: "0" }],
        },
        []
      )
    ).toThrow(/above gross/);
  });
});

describe("foldCashByOrgDay agency money", () => {
  it("serves agency money apart, never inside gross/net, totals = Σ rows", () => {
    const out = foldCashByOrgDay(
      {
        asOf: "2026-11-21T16:30:00.000Z",
        totalGrossCents: "115015",
        totalNetCents: "115015",
        totalAgencyGrossCents: "325000",
        totalAgencyNetCents: "325000",
        rows: [
          { orgId: null, day: "2026-09-09", grossCents: "0", netCents: "0", agencyGrossCents: "200000", agencyNetCents: "200000" },
          { orgId: "91e76989-71ba-420d-ba73-bb3961430aa7", day: "2026-10-11", grossCents: "115015", netCents: "115015", agencyGrossCents: "125000", agencyNetCents: "125000" },
        ],
      },
      []
    );
    expect(out.total_gross_cents).toBe("115015.0000000000");
    expect(out.total_agency_gross_cents).toBe("325000.0000000000");
    expect(out.rows[0]).toEqual({
      org_id: null,
      day: "2026-09-09",
      gross_cents: "0.0000000000",
      net_cents: "0.0000000000",
      agency_gross_cents: "200000.0000000000",
      agency_net_cents: "200000.0000000000",
    });
  });

  it("throws when agency totals disagree with rows", () => {
    expect(() =>
      foldCashByOrgDay(
        {
          asOf: "x",
          totalGrossCents: "0",
          totalNetCents: "0",
          totalAgencyGrossCents: "1",
          totalAgencyNetCents: "0",
          rows: [{ orgId: null, day: "2026-09-09", grossCents: "0", netCents: "0", agencyGrossCents: "0", agencyNetCents: "0" }],
        },
        []
      )
    ).toThrow(/agency gross/);
  });
});
