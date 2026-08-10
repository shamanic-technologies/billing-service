import { describe, it, expect } from "vitest";
import {
  decideAttribution,
  toBillingFunnelKey,
  UnknownDeclaredFunnelError,
} from "../../src/lib/single-funnel-attribution.js";

const brandId = "00000000-0000-0000-0000-0000000fb601";

describe("single-funnel attribution decision", () => {
  // --- Funnel-key vocabulary: brand-service emits canonical, billing stores legacy ---

  it("collapses brand-service's canonical spellings onto billing's keys", () => {
    expect(toBillingFunnelKey("sales_meetings_from_conversation", brandId)).toBe(
      "reply_meeting"
    );
    expect(toBillingFunnelKey("sales_meetings_from_website", brandId)).toBe(
      "visit_meeting"
    );
    expect(toBillingFunnelKey("website_purchases", brandId)).toBe("visit_signup");
    expect(toBillingFunnelKey("form_magnet", brandId)).toBe("visit_form");
  });

  it("passes billing's own spellings through unchanged", () => {
    expect(toBillingFunnelKey("visit_form", brandId)).toBe("visit_form");
    expect(toBillingFunnelKey("reply_meeting", brandId)).toBe("reply_meeting");
  });

  it("THROWS on a funnel spelling neither vocabulary can name", () => {
    // A silent skip would read exactly like "this brand declared nothing", which
    // is a legitimate outcome — so drift has to abort the sweep instead.
    expect(() => toBillingFunnelKey("carrier_pigeon", brandId)).toThrow(
      UnknownDeclaredFunnelError
    );
    expect(() =>
      decideAttribution({
        brandId,
        dailyBudgetCents: "5000.0000000000",
        declaredFunnelKeys: ["carrier_pigeon"],
      })
    ).toThrow(UnknownDeclaredFunnelError);
  });

  // --- The unambiguous case: one funded ceiling, one funnel ---

  it("attributes a funded ceiling to the single funnel the brand sells through", () => {
    expect(
      decideAttribution({
        brandId,
        dailyBudgetCents: "5000.0000000000",
        declaredFunnelKeys: ["sales_meetings_from_conversation"],
      })
    ).toEqual({ attribute: true, funnelKey: "reply_meeting" });
  });

  it("attributes a ceiling that sits BELOW its funnel's product minimum", () => {
    // The minimums police what a customer may newly state. This ceiling is one
    // they are already charged against, and several live ones are under it —
    // refusing them would leave the exact incoherence this removes.
    expect(
      decideAttribution({
        brandId,
        dailyBudgetCents: "100.0000000000",
        declaredFunnelKeys: ["sales_meetings_from_website"],
      })
    ).toEqual({ attribute: true, funnelKey: "visit_meeting" });
  });

  it("treats the same funnel declared twice as one funnel", () => {
    expect(
      decideAttribution({
        brandId,
        dailyBudgetCents: "2000.0000000000",
        declaredFunnelKeys: ["form_magnet", "visit_form"],
      })
    ).toEqual({ attribute: true, funnelKey: "visit_form" });
  });

  // --- Every ambiguous case is left exactly as it is ---

  it("refuses a brand selling through more than one funnel", () => {
    const decision = decideAttribution({
      brandId,
      dailyBudgetCents: "5000.0000000000",
      declaredFunnelKeys: ["form_magnet", "website_purchases"],
    });
    expect(decision.attribute).toBe(false);
    expect(decision).toMatchObject({
      reason: expect.stringContaining("2 funnels"),
    });
  });

  it("refuses a brand that declares no active funnel", () => {
    const decision = decideAttribution({
      brandId,
      dailyBudgetCents: "5000.0000000000",
      declaredFunnelKeys: [],
    });
    expect(decision.attribute).toBe(false);
    expect(decision).toMatchObject({
      reason: expect.stringContaining("no active sales funnel"),
    });
  });

  it("refuses an unfunded (0) brand-level ceiling", () => {
    const decision = decideAttribution({
      brandId,
      dailyBudgetCents: "0.0000000000",
      declaredFunnelKeys: ["form_magnet"],
    });
    expect(decision.attribute).toBe(false);
    expect(decision).toMatchObject({
      reason: expect.stringContaining("not funded"),
    });
  });
});
