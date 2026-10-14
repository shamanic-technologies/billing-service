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
import { channelCatalogueFrom } from "../../src/lib/budget-change-context.js";
import { salesPathTermsOf, termsIndexFrom } from "../../src/lib/sales-path-terms.js";

const COLD = "sales-cold-email-outreach";
const CALL = "cold-call-outreach";
const META = "meta-ads";
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
