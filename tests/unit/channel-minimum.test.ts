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

/**
 * Every acquisition channel the published catalogue puts in the `conversion`
 * family — the ones that take a lead already on a funnel and move it to the next
 * step — with the floor this service states for each. Read from that
 * catalogue's own `terms.dailyOperatingCostCents`: the money the channel costs
 * to run for a day. The customer-operated ones spend none of the platform's
 * money and publish zero, so their floor is a stated 0.
 */
const INTERNAL_LEG_CHANNEL_FLOORS: Record<string, number> = {
  "ai-meeting-booking": 100,
  "agency-meeting-booking": 0,
  "agency-meeting-attendance": 6000,
  "agency-closing-calls": 30000,
  "agency-signup-conversion": 15000,
  "your-team-meeting-booking": 0,
  "your-team-meeting-attendance": 0,
  "your-team-closing-calls": 0,
  "your-team-signup-conversion": 0,
};

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

    // Google Ads is the only channel that OPENS a funnel and states a floor of
    // its own; every other stated floor belongs to the conversion family, which
    // converts an internal leg rather than opening anything.
    const stated = Object.entries(ACQUISITION_CHANNEL_MIN_DAILY_BUDGET_CENTS)
      .filter(([, min]) => min !== null)
      .map(([slug]) => slug)
      .sort();
    expect(stated).toEqual(
      [GOOGLE_ADS, ...Object.keys(INTERNAL_LEG_CHANNEL_FLOORS)].sort()
    );
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

  it("prices every channel that converts an INTERNAL funnel leg", () => {
    for (const [slug, floor] of Object.entries(INTERNAL_LEG_CHANNEL_FLOORS)) {
      expect(isKnownAcquisitionChannel(slug)).toBe(true);
      expect(statedChannelMinimum(slug)).toBe(floor);
      // The floor is the channel's own on EVERY funnel it may be sold through —
      // it never inherits the funnel's, which is what refused it before.
      for (const funnelKey of ["reply_meeting", "visit_meeting", "visit_signup", "visit_form"] as const) {
        expect(minDailyBudgetCentsFor(funnelKey, slug)).toBe(floor);
      }
    }
  });

  it("lets a customer fund the automated meeting booking at $1/day on a reply-to-meeting funnel", () => {
    // The reported case: the funnel's own floor is $24/day, and this channel's
    // is $1/day, so $1/day funds it.
    expect(minDailyBudgetCentsFor("reply_meeting", "ai-meeting-booking")).toBe(100);
    expect(() =>
      assertFundedChannelMeetsMinimum("reply_meeting", "ai-meeting-booking", "100", null)
    ).not.toThrow();
    expect(() =>
      assertFundedChannelMeetsMinimum("reply_meeting", "ai-meeting-booking", "99", null)
    ).toThrow(FunnelBudgetBelowMinimumError);
    // Judged ALONE, so its funnel siblings' $150/day neither funds it nor is
    // spent by it.
    expect(minimumGroupOf("reply_meeting", "ai-meeting-booking")).not.toBe(
      minimumGroupOf("reply_meeting", COLD)
    );
  });

  it("funds a channel the CUSTOMER operates at any amount, including nothing", () => {
    // It spends none of the platform's money, so there is no number to demand.
    for (const slug of Object.keys(INTERNAL_LEG_CHANNEL_FLOORS).filter((s) =>
      s.startsWith("your-team-")
    )) {
      expect(statedChannelMinimum(slug)).toBe(0);
      for (const amount of ["0", "1", "100000"]) {
        expect(() =>
          assertFundedChannelMeetsMinimum("reply_meeting", slug, amount, null)
        ).not.toThrow();
      }
      // A stated 0 is NOT an absent floor: it keeps the channel judged alone
      // rather than pooled into a funnel group whose $24/day it would fail.
      expect(minimumGroupOf("reply_meeting", slug)).not.toBe(
        minimumGroupOf("reply_meeting", COLD)
      );
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
