/**
 * Wave 1 of the outbound leg-key rename (owner 2026-10-09, lib/leg-identity):
 * the legacy and the new spelling of an OUTBOUND leg are one identity; the same
 * legacy key on a non-outbound channel stays itself.
 */
import { describe, it, expect } from "vitest";
import {
  canonicalLegKey,
  legIdentityKey,
  legKeySpellings,
  sameLeg,
} from "../../src/lib/leg-identity.js";
import {
  campaignCeilingRows,
  legBudgetRows,
} from "../../src/lib/campaign-budgets.js";
import { channelCatalogueFrom } from "../../src/lib/budget-change-context.js";
import { salesPathTermsOf, termsIndexFrom } from "../../src/lib/sales-path-terms.js";
import type { CeilingRow } from "../../src/db/schema.js";

const COLD = "sales-cold-email-outreach";
const CALL = "cold-call-outreach";
const META = "meta-ads";
const OFFER = "aaaaaaaa-0000-4000-8000-000000000001";

function row(featureSlug: string, legKey: string | null, cents: string): CeilingRow {
  return {
    orgId: "o",
    brandId: "b",
    featureSlug,
    offerId: OFFER,
    legKey,
    dailyBudgetCents: cents,
    monthlyBudgetCents: null,
    sourcingCeilingCents: null,
    planDerived: false,
    updatedAt: new Date("2026-10-09T00:00:00Z"),
  } as CeilingRow;
}

describe("leg identity", () => {
  it("renames only the two legacy keys, only on outbound channels", () => {
    expect(canonicalLegKey(COLD, "start_to_conversation")).toBe("lead_found_to_conversation");
    expect(canonicalLegKey(CALL, "start_to_website_visit")).toBe("lead_found_to_website_visit");
    expect(canonicalLegKey(COLD, "lead_found_to_conversation")).toBe("lead_found_to_conversation");
    expect(canonicalLegKey(META, "start_to_website_visit")).toBe("start_to_website_visit");
    expect(canonicalLegKey("sourcing-apollo-cold-filters", "start_to_lead_found")).toBe("start_to_lead_found");
    expect(canonicalLegKey(COLD, "conversation_to_meeting_booked")).toBe("conversation_to_meeting_booked");
    expect(canonicalLegKey(COLD, null)).toBeNull();
  });

  it("sameLeg / spellings / identity key", () => {
    expect(sameLeg(COLD, "start_to_conversation", "lead_found_to_conversation")).toBe(true);
    expect(sameLeg(COLD, "start_to_conversation", "lead_found_to_website_visit")).toBe(false);
    expect(sameLeg(META, "start_to_website_visit", "lead_found_to_website_visit")).toBe(false);
    expect(sameLeg(COLD, null, null)).toBe(true);
    expect(sameLeg(COLD, null, "start_to_conversation")).toBe(false);
    expect(legKeySpellings(COLD, "lead_found_to_conversation")).toEqual([
      "start_to_conversation",
      "lead_found_to_conversation",
    ]);
    expect(legKeySpellings(META, "start_to_website_visit")).toEqual(["start_to_website_visit"]);
    expect(legIdentityKey(COLD, "start_to_conversation")).toBe(legIdentityKey(COLD, "lead_found_to_conversation"));
    expect(legIdentityKey(META, "start_to_website_visit")).not.toBe(
      legIdentityKey(META, "lead_found_to_website_visit")
    );
  });

  it("a campaign asked under either spelling finds the one stored ceiling", () => {
    const rows = [row(COLD, "start_to_conversation", "500"), row(COLD, "start_to_website_visit", "300")];
    for (const legKey of ["start_to_conversation", "lead_found_to_conversation"]) {
      const owned = campaignCeilingRows(rows, { offerId: OFFER, legKey, featureSlug: COLD });
      expect(owned.map((r) => r.dailyBudgetCents)).toEqual(["500"]);
    }
    // A non-outbound channel keeps its own key: the new spelling names nothing there.
    const meta = [row(META, "start_to_website_visit", "900")];
    expect(campaignCeilingRows(meta, { offerId: OFFER, legKey: "lead_found_to_website_visit", featureSlug: META })).toEqual([]);
  });

  it("a per-leg read: either spelling counts the outbound rows, never a non-outbound row under the new key", () => {
    const rows = [
      row(COLD, "start_to_website_visit", "500"),
      row(CALL, "lead_found_to_website_visit", "200"),
      row(META, "start_to_website_visit", "900"),
    ];
    const sum = (r: CeilingRow[]) => r.map((x) => x.dailyBudgetCents).sort();
    expect(sum(legBudgetRows(rows, "start_to_website_visit"))).toEqual(["200", "500", "900"]);
    expect(sum(legBudgetRows(rows, "lead_found_to_website_visit"))).toEqual(["200", "500"]);
  });

  it("the published terms and the email catalogue answer under either spelling", () => {
    const channels = [
      {
        slug: COLD,
        operatedBy: "platform",
        managed: true,
        stepTransitions: [{ legKey: "start_to_conversation", from: null, reactive: false, minimumMonthlyBudgetCents: 9900 }],
      },
      {
        slug: CALL,
        operatedBy: "platform",
        managed: false,
        // What features-service will publish: the new key, starting at lead_found.
        stepTransitions: [
          { legKey: "lead_found_to_conversation", from: { key: "lead_found" }, reactive: false, minimumMonthlyBudgetCents: 150000 },
        ],
      },
    ];
    const terms = salesPathTermsOf(termsIndexFrom(channels).items);
    expect(terms.termsFor(COLD, "lead_found_to_conversation")?.minimumMonthlyCents).toBe(9900);
    expect(terms.termsFor(CALL, "start_to_conversation")?.minimumMonthlyCents).toBe(150000);
    // A leg starting at lead_found is still daily: the explicit flag decides.
    expect(terms.termsFor(CALL, "start_to_conversation")?.role).toBe("proactive");

    const catalogue = channelCatalogueFrom([
      {
        slug: CALL,
        name: "Cold call outreach",
        stepTransitions: [
          { legKey: "lead_found_to_conversation", reactive: false, from: { label: "Lead found" }, to: { label: "Positive reply" } },
        ],
      },
    ]);
    const leg = catalogue.get(CALL)!.legs.get(canonicalLegKey(CALL, "start_to_conversation"));
    expect(leg).toMatchObject({ reactive: false, toLabel: "Positive reply" });
  });
});
