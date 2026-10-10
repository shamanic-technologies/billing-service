import { describe, it, expect } from "vitest";
import { periodWindow, volumeUnitOf } from "../../src/lib/sales-funnel-caps.js";
import {
  salesFunnelFromDetail,
  SalesFunnelCatalogueUnavailableError,
} from "../../src/lib/sales-funnel-catalogue.js";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

describe("periodWindow (UTC)", () => {
  const since = new Date("2026-09-20T08:00:00.000Z");

  it("daily = the UTC calendar day", () => {
    const w = periodWindow("daily", since, new Date("2026-10-10T13:45:00.000Z"));
    expect([iso(w.start), iso(w.end)]).toEqual(["2026-10-10T00:00:00.000Z", "2026-10-11T00:00:00.000Z"]);
  });

  it("weekly starts Monday 00:00 (a Saturday, a Sunday, a Monday)", () => {
    // 2026-10-10 is a Saturday.
    const sat = periodWindow("weekly", since, new Date("2026-10-10T13:45:00.000Z"));
    expect([iso(sat.start), iso(sat.end)]).toEqual(["2026-10-05T00:00:00.000Z", "2026-10-12T00:00:00.000Z"]);
    const sun = periodWindow("weekly", since, new Date("2026-10-11T23:59:59.000Z"));
    expect(iso(sun.start)).toBe("2026-10-05T00:00:00.000Z");
    const mon = periodWindow("weekly", since, new Date("2026-10-12T00:00:00.000Z"));
    expect([iso(mon.start), iso(mon.end)]).toEqual(["2026-10-12T00:00:00.000Z", "2026-10-19T00:00:00.000Z"]);
  });

  it("monthly = the UTC calendar month", () => {
    const w = periodWindow("monthly", since, new Date("2026-12-31T23:00:00.000Z"));
    expect([iso(w.start), iso(w.end)]).toEqual(["2026-12-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"]);
  });

  it("one_off counts from when the cap was stated and never ends", () => {
    const w = periodWindow("one_off", since, new Date("2026-10-10T13:45:00.000Z"));
    expect([iso(w.start), iso(w.end)]).toEqual(["2026-09-20T08:00:00.000Z", null]);
  });
});

describe("salesFunnelFromDetail", () => {
  // Shaped exactly like features-service's prod answer (2026-10-10, "Epiphany").
  const epiphany = {
    object: "sales_funnel",
    id: "lead_found_to_website_visit@sales-cold-email-outreach+website_visit_to_purchase+purchase_to_paid_client",
    name: "Epiphany",
    legs: [
      {
        legKey: "lead_found_to_website_visit",
        pipe: { id: "sales-cold-email-outreach|lead_found_to_website_visit", name: "Lumen", mode: "proactive" },
      },
      { legKey: "website_visit_to_purchase", pipe: null },
      { legKey: "purchase_to_paid_client", pipe: null },
    ],
  };

  it("reads the pipes, skipping legs nothing of ours performs", () => {
    expect(salesFunnelFromDetail(epiphany.id, epiphany)).toEqual({
      id: epiphany.id,
      name: "Epiphany",
      type: null,
      pipes: [
        {
          pipeId: "sales-cold-email-outreach|lead_found_to_website_visit",
          channelSlug: "sales-cold-email-outreach",
          legKey: "lead_found_to_website_visit",
          mode: "proactive",
        },
      ],
    });
  });

  it("relays the served type; anything else is null (never derived from pipe modes)", () => {
    expect(salesFunnelFromDetail(epiphany.id, { ...epiphany, type: "proactive" }).type).toBe("proactive");
    expect(salesFunnelFromDetail(epiphany.id, { ...epiphany, type: "reactive" }).type).toBe("reactive");
    // A reactive label on a funnel with a proactive pipe is relayed as served, not re-graded.
    expect(salesFunnelFromDetail(epiphany.id, { ...epiphany, type: "Proactive" }).type).toBeNull();
  });

  it("volumeUnitOf: first contacts with a proactive pipe, prospects handled when all reactive", () => {
    const pipe = (mode: "proactive" | "reactive") => ({ pipeId: "a|b", channelSlug: "a", legKey: "b", mode });
    expect(volumeUnitOf({ pipes: [pipe("reactive"), pipe("proactive")] })).toBe("first_contacts");
    expect(volumeUnitOf({ pipes: [pipe("reactive")] })).toBe("prospects_handled");
  });

  it("refuses a pipe id without <channel>|<leg>, a missing mode, or no legs", () => {
    const bad = (pipe: unknown) => ({ ...epiphany, legs: [{ legKey: "x", pipe }] });
    expect(() => salesFunnelFromDetail("f", bad({ id: "no-bar", mode: "proactive" }))).toThrow(
      SalesFunnelCatalogueUnavailableError
    );
    expect(() => salesFunnelFromDetail("f", bad({ id: "a|b" }))).toThrow(SalesFunnelCatalogueUnavailableError);
    expect(() => salesFunnelFromDetail("f", { id: "f" })).toThrow(SalesFunnelCatalogueUnavailableError);
  });
});
