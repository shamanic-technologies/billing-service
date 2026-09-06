/**
 * The floor a funded ceiling must clear is a property of the ACQUISITION
 * CHANNEL, and it IS that channel's published daily operating cost. Cold email
 * costs what cold email costs whatever funnel the leads later travel, so two
 * campaigns on the same channel share a floor even when their funnels differ.
 * The funnel identifies a ceiling; it does not price one.
 */
import { describe, it, expect } from "vitest";
import {
  assertFundedChannelMeetsMinimum,
  FunnelBudgetBelowMinimumError,
  UnknownAcquisitionChannelError,
  minimumGroupOf,
  BRAND_FUNNEL_KEYS,
  DEFAULT_ACQUISITION_CHANNEL_FEATURE_SLUG,
} from "../../src/lib/brand-funnel-budgets.js";
import {
  channelMinimumsFrom,
  channelMinimumsOf,
} from "../../src/lib/channel-terms.js";
import {
  PUBLISHED_CHANNEL_DAILY_OPERATING_COST_CENTS as PUBLISHED,
  publishedChannelsBody,
} from "../helpers/channel-catalogue.js";

const COLD = "sales-cold-email-outreach";
const CRM = "sales-crm-email-outreach";
const GOOGLE_ADS = "google-ads";

/** The floors exactly as billing resolves them from the published terms. */
const minimums = channelMinimumsOf(
  channelMinimumsFrom(publishedChannelsBody().channels)
);

const assert = (
  funnelKey: (typeof BRAND_FUNNEL_KEYS)[number],
  featureSlug: string,
  value: string,
  stored: string | null = null
) =>
  assertFundedChannelMeetsMinimum(
    funnelKey,
    featureSlug,
    value,
    stored,
    minimums
  );

describe("the minimum is the channel's published daily operating cost", () => {
  it("prices cold email at the $8/day its terms state", () => {
    expect(minimums.minimumFor(COLD)).toBe(800);
    expect(PUBLISHED[COLD]).toBe(800);
  });

  it("accepts a cold-email campaign at $8/day and refuses it below", () => {
    for (const funnelKey of BRAND_FUNNEL_KEYS) {
      expect(() => assert(funnelKey, COLD, "800")).not.toThrow();
      expect(() => assert(funnelKey, COLD, "799")).toThrow(
        FunnelBudgetBelowMinimumError
      );
    }
  });

  it("gives two campaigns on ONE channel the same floor whatever their funnels", () => {
    for (const slug of Object.keys(PUBLISHED)) {
      const floor = minimums.minimumFor(slug);
      expect(floor).toBe(PUBLISHED[slug]);
      // The funnel plays no part in the figure.
      for (const funnelKey of BRAND_FUNNEL_KEYS) {
        if (floor === 0) continue;
        expect(() => assert(funnelKey, slug, String(floor))).not.toThrow();
        expect(() => assert(funnelKey, slug, String(floor - 1))).toThrow(
          FunnelBudgetBelowMinimumError
        );
      }
    }
  });

  it("drops the $24/day the two meeting funnels used to impose on cold email", () => {
    // Both were 2400 while the funnel decided the floor.
    expect(() => assert("reply_meeting", COLD, "800")).not.toThrow();
    expect(() => assert("visit_meeting", COLD, "800")).not.toThrow();
  });

  it("names the channel in the refusal, since the floor is the channel's", () => {
    let message = "";
    try {
      assert("reply_meeting", COLD, "500");
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message).toContain(COLD);
    expect(message).toContain("$8/day");
    expect(message).toContain("channel");
  });

  it("keeps 0 an ordinary value on every priced channel", () => {
    for (const slug of Object.keys(PUBLISHED)) {
      expect(() => assert("reply_meeting", slug, "0")).not.toThrow();
    }
  });

  it("treats a stated 0 as a floor, not as an absent one", () => {
    // A channel the CUSTOMER operates spends none of our money.
    expect(minimums.minimumFor("your-team-meeting-booking")).toBe(0);
    expect(() =>
      assert("reply_meeting", "your-team-meeting-booking", "1")
    ).not.toThrow();
  });

  it("prices the default channel, so a slug-less write always resolves a floor", () => {
    expect(minimums.prices(DEFAULT_ACQUISITION_CHANNEL_FEATURE_SLUG)).toBe(true);
  });
});

describe("a channel the published terms do not price", () => {
  it("is refused BY NAME, at any amount including 0", () => {
    expect(() => assert("visit_form", "carrier-pigeon-outreach", "10000")).toThrow(
      UnknownAcquisitionChannelError
    );
    expect(() => assert("visit_form", "carrier-pigeon-outreach", "0")).toThrow(
      UnknownAcquisitionChannelError
    );
  });

  it("gets no invented default floor", () => {
    expect(() => minimums.minimumFor("carrier-pigeon-outreach")).toThrow(
      UnknownAcquisitionChannelError
    );
    expect(minimums.prices("carrier-pigeon-outreach")).toBe(false);
  });
});

describe("which ceilings are judged together", () => {
  it("judges each (funnel, channel) pair on its own money", () => {
    expect(minimumGroupOf("visit_meeting", COLD)).not.toBe(
      minimumGroupOf("visit_meeting", CRM)
    );
    expect(minimumGroupOf("visit_meeting", COLD)).not.toBe(
      minimumGroupOf("visit_meeting", GOOGLE_ADS)
    );
    expect(minimumGroupOf("visit_meeting", COLD)).not.toBe(
      minimumGroupOf("reply_meeting", COLD)
    );
  });

  it("is stable for the same pair", () => {
    expect(minimumGroupOf("visit_meeting", COLD)).toBe(
      minimumGroupOf("visit_meeting", COLD)
    );
  });
});

describe("the grandfather, unchanged in spirit", () => {
  // A ceiling carried over below its floor may be kept or raised, never lowered
  // to another funded sub-minimum value.
  const gf = (value: number, stored: number | null) =>
    assert("reply_meeting", COLD, String(value), stored === null ? null : String(stored));

  it("refuses a funded sub-minimum value with no stored ceiling", () => {
    expect(() => gf(500, null)).toThrow(/needs at least \$8\/day/);
  });

  it("accepts re-stating and raising a grandfathered ceiling", () => {
    expect(() => gf(500, 500)).not.toThrow();
    expect(() => gf(600, 500)).not.toThrow();
    expect(() => gf(900, 500)).not.toThrow();
  });

  it("accepts defunding it", () => {
    expect(() => gf(0, 500)).not.toThrow();
  });

  it("REFUSES lowering it to another funded sub-minimum value", () => {
    expect(() => gf(400, 500)).toThrow(FunnelBudgetBelowMinimumError);
  });

  it("spends the grandfather once the ceiling reaches the floor", () => {
    expect(() => gf(800, 500)).not.toThrow();
    expect(() => gf(500, 800)).toThrow(FunnelBudgetBelowMinimumError);
  });

  it("says what the customer CAN do", () => {
    let message = "";
    try {
      gf(400, 500);
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message).toContain("keep it at $5/day");
    expect(message).toContain("raise it");
    expect(message).toContain("set it to 0");
  });

  it("grandfathers a ceiling the OLD $24/day funnel floor left stranded", () => {
    // $10/day on a reply-to-meeting funnel: below $24 then, above $8 now — so it
    // is simply funded, and can be lowered to anything at or above $8.
    expect(() => gf(1000, 1000)).not.toThrow();
    expect(() => gf(800, 1000)).not.toThrow();
  });
});
