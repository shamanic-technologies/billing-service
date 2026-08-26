/**
 * The viable floor is a property of the sales funnel AND the acquisition
 * CHANNEL, not of the funnel alone: a cold-email funnel and a paid-ads funnel do
 * not become viable at the same daily number. Google Ads states $5/day on every
 * funnel it sells; no other channel's floor moves.
 */
import { describe, it, expect } from "vitest";
import {
  ACQUISITION_CHANNEL_MIN_DAILY_BUDGET_CENTS,
  BRAND_FUNNEL_MIN_DAILY_BUDGET_CENTS,
  assertFundedChannelMeetsMinimum,
  FunnelBudgetBelowMinimumError,
  UnknownAcquisitionChannelError,
  isKnownAcquisitionChannel,
  minDailyBudgetCentsFor,
  minimumGroupOf,
  statedChannelMinimum,
  DEFAULT_ACQUISITION_CHANNEL_FEATURE_SLUG,
} from "../../src/lib/brand-funnel-budgets.js";

const GOOGLE_ADS = "google-ads";
const COLD = "sales-cold-email-outreach";
// The three visit-led funnels Google Ads sells, in this service's spelling.
const GOOGLE_ADS_FUNNELS = ["visit_meeting", "visit_signup", "visit_form"] as const;

describe("per-acquisition-channel product minimum", () => {
  it("prices Google Ads at $5/day on every funnel it sells", () => {
    for (const funnelKey of GOOGLE_ADS_FUNNELS) {
      expect(minDailyBudgetCentsFor(funnelKey, GOOGLE_ADS)).toBe(500);
    }
    // Two of them rise from $1/day, and the visit-to-meeting funnel DROPS from
    // $24/day — on this channel only.
    expect(BRAND_FUNNEL_MIN_DAILY_BUDGET_CENTS.visit_signup).toBe(100);
    expect(BRAND_FUNNEL_MIN_DAILY_BUDGET_CENTS.visit_meeting).toBe(2400);
  });

  it("refuses a newly stated Google Ads ceiling below $5/day, accepts $5 and up", () => {
    for (const funnelKey of GOOGLE_ADS_FUNNELS) {
      expect(() =>
        assertFundedChannelMeetsMinimum(funnelKey, GOOGLE_ADS, "499", null)
      ).toThrow(FunnelBudgetBelowMinimumError);
      expect(() =>
        assertFundedChannelMeetsMinimum(funnelKey, GOOGLE_ADS, "500", null)
      ).not.toThrow();
      expect(() =>
        assertFundedChannelMeetsMinimum(funnelKey, GOOGLE_ADS, "5000", null)
      ).not.toThrow();
    }
  });

  it("names the channel in the refusal, since the floor is the channel's own", () => {
    let message = "";
    try {
      assertFundedChannelMeetsMinimum("visit_meeting", GOOGLE_ADS, "100", null);
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message).toContain("google-ads");
    expect(message).toContain("$5/day");
    expect(message).toContain("$1/day"); // what they actually sent
  });

  it("leaves every other channel's floor exactly where it was", () => {
    // Same funnels, funded through cold email: the pre-Google-Ads floors.
    expect(minDailyBudgetCentsFor("visit_meeting", COLD)).toBe(2400);
    expect(minDailyBudgetCentsFor("visit_signup", COLD)).toBe(100);
    expect(minDailyBudgetCentsFor("visit_form", COLD)).toBe(100);
    expect(minDailyBudgetCentsFor("reply_meeting", COLD)).toBe(2400);

    expect(() =>
      assertFundedChannelMeetsMinimum("visit_meeting", COLD, "500", null)
    ).toThrow(FunnelBudgetBelowMinimumError);
    expect(() =>
      assertFundedChannelMeetsMinimum("visit_signup", COLD, "100", null)
    ).not.toThrow();

    // Google Ads is the ONLY channel stating a floor of its own today.
    const stated = Object.entries(ACQUISITION_CHANNEL_MIN_DAILY_BUDGET_CENTS)
      .filter(([, min]) => min !== null)
      .map(([slug]) => slug);
    expect(stated).toEqual([GOOGLE_ADS]);
  });

  it("accepts zero on every channel, priced floor or not", () => {
    expect(() =>
      assertFundedChannelMeetsMinimum("visit_meeting", GOOGLE_ADS, "0", null)
    ).not.toThrow();
    expect(() =>
      assertFundedChannelMeetsMinimum("visit_meeting", COLD, "0", null)
    ).not.toThrow();
    expect(() =>
      assertFundedChannelMeetsMinimum("visit_meeting", GOOGLE_ADS, "0", "5000")
    ).not.toThrow();
  });

  it("grandfathers a sub-floor Google Ads ceiling exactly as it does elsewhere", () => {
    // Keep it, raise it (still sub-floor), raise it past the floor, or zero it.
    expect(() =>
      assertFundedChannelMeetsMinimum("visit_form", GOOGLE_ADS, "100", "100")
    ).not.toThrow();
    expect(() =>
      assertFundedChannelMeetsMinimum("visit_form", GOOGLE_ADS, "300", "100")
    ).not.toThrow();
    expect(() =>
      assertFundedChannelMeetsMinimum("visit_form", GOOGLE_ADS, "900", "100")
    ).not.toThrow();
    expect(() =>
      assertFundedChannelMeetsMinimum("visit_form", GOOGLE_ADS, "0", "100")
    ).not.toThrow();
    // Lowering to another funded sub-floor value is a NEW statement below it.
    expect(() =>
      assertFundedChannelMeetsMinimum("visit_form", GOOGLE_ADS, "50", "100")
    ).toThrow(FunnelBudgetBelowMinimumError);
  });

  it("fails loudly on a channel it does not price, rather than defaulting", () => {
    expect(isKnownAcquisitionChannel("carrier-pigeon-outreach")).toBe(false);
    expect(() =>
      minDailyBudgetCentsFor("visit_form", "carrier-pigeon-outreach")
    ).toThrow(UnknownAcquisitionChannelError);
    // Even at zero: an unpriced channel is never stored, so it can never be
    // re-stated later at a floor nobody chose for it.
    expect(() =>
      assertFundedChannelMeetsMinimum(
        "visit_form",
        "carrier-pigeon-outreach",
        "0",
        null
      )
    ).toThrow(UnknownAcquisitionChannelError);
    expect(() => statedChannelMinimum("carrier-pigeon-outreach")).toThrow(
      UnknownAcquisitionChannelError
    );
  });

  it("prices every channel a live ceiling is funded through today", () => {
    for (const slug of [
      DEFAULT_ACQUISITION_CHANNEL_FEATURE_SLUG,
      "sales-crm-email-outreach",
      "feedback-request-cold-email-outreach",
      GOOGLE_ADS,
    ]) {
      expect(isKnownAcquisitionChannel(slug)).toBe(true);
    }
  });

  it("judges a channel with its own floor ALONE, and the rest with their funnel", () => {
    // Two channels stating no floor share their funnel's group, so a split is
    // judged on the sum — exactly as before Google Ads arrived.
    expect(minimumGroupOf("visit_meeting", COLD)).toBe(
      minimumGroupOf("visit_meeting", "sales-crm-email-outreach")
    );
    // Google Ads is its own group: neither its siblings' money nor their floor
    // has anything to say about whether it can run, and vice versa.
    expect(minimumGroupOf("visit_meeting", GOOGLE_ADS)).not.toBe(
      minimumGroupOf("visit_meeting", COLD)
    );
    // ...and the group is per funnel, so one funnel's split never licenses
    // another's.
    expect(minimumGroupOf("visit_form", COLD)).not.toBe(
      minimumGroupOf("visit_meeting", COLD)
    );
  });
});
