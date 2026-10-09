import { describe, it, expect } from "vitest";
import { findLegacyOutboundLegKeys } from "../../src/lib/legacy-leg-key-log.js";

describe("findLegacyOutboundLegKeys", () => {
  it("finds legacy outbound keys in nested body items, snake_case and the campaigns query", () => {
    const found = findLegacyOutboundLegKeys({
      body: {
        items: [
          { featureSlug: "cold-call-outreach", legKey: "start_to_website_visit", budgetCents: 100 },
          { featureSlug: "cold-call-outreach", legKey: "lead_found_to_conversation" },
          { featureSlug: "google-ads", legKey: "start_to_conversation" },
        ],
        mission: { feature_slug: "cold-x-outreach", leg_key: "start_to_conversation" },
      },
      query: { campaigns: "sales-cold-email-outreach:start_to_conversation,meta-ads:start_to_website_visit" },
    } as never);
    expect(found).toEqual([
      { featureSlug: "cold-call-outreach", legKey: "start_to_website_visit", source: "body" },
      { featureSlug: "cold-x-outreach", legKey: "start_to_conversation", source: "body" },
      { featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation", source: "query.campaigns" },
    ]);
  });

  it("finds nothing on a request without leg keys", () => {
    expect(findLegacyOutboundLegKeys({ body: undefined, query: {} } as never)).toEqual([]);
    expect(findLegacyOutboundLegKeys({ body: { legKey: "start_to_lead_found", featureSlug: "sourcing-apollo-cold-filters" }, query: {} } as never)).toEqual([]);
  });
});
