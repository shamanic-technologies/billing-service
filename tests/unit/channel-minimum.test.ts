/**
 * The floor a funded ceiling must clear is a property of the ACQUISITION
 * CHANNEL, and it IS that channel's published daily operating cost. Cold email
 * costs what cold email costs whatever leg it moves leads along, so two
 * campaigns on the same channel share a floor.
 */
import { describe, it, expect } from "vitest";
import {
  assertChannelMeetsMinimum,
  CeilingBelowMinimumError,
  UnknownAcquisitionChannelError,
} from "../../src/lib/campaign-budgets.js";
import {
  channelMinimumsFrom,
  channelMinimumsOf,
} from "../../src/lib/channel-terms.js";
import {
  PUBLISHED_CHANNEL_DAILY_OPERATING_COST_CENTS as PUBLISHED,
  publishedChannelsBody,
} from "../helpers/channel-catalogue.js";

const COLD = "sales-cold-email-outreach";

/** The floors exactly as billing resolves them from the published terms. */
const minimums = channelMinimumsOf(
  channelMinimumsFrom(publishedChannelsBody().channels)
);

const assert = (
  featureSlug: string,
  value: string,
  stored: string | null = null
) => assertChannelMeetsMinimum(featureSlug, value, stored, minimums);

describe("the minimum is the channel's published daily operating cost", () => {
  it("prices cold email at the $8/day its terms state", () => {
    expect(minimums.minimumFor(COLD)).toBe(800);
    expect(PUBLISHED[COLD]).toBe(800);
  });

  it("accepts a cold-email campaign at $8/day and refuses it below", () => {
    expect(() => assert(COLD, "800")).not.toThrow();
    expect(() => assert(COLD, "799")).toThrow(CeilingBelowMinimumError);
  });

  it("applies every published channel's own floor", () => {
    for (const slug of Object.keys(PUBLISHED)) {
      const floor = minimums.minimumFor(slug);
      expect(floor).toBe(PUBLISHED[slug]);
      if (floor === 0) continue;
      expect(() => assert(slug, String(floor))).not.toThrow();
      expect(() => assert(slug, String(floor - 1))).toThrow(
        CeilingBelowMinimumError
      );
    }
  });

  it("names the channel in the refusal, since the floor is the channel's", () => {
    let message = "";
    try {
      assert(COLD, "500");
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message).toContain(COLD);
    expect(message).toContain("$8/day");
    expect(message).toContain("channel");
  });

  it("keeps 0 an ordinary value on every priced channel", () => {
    for (const slug of Object.keys(PUBLISHED)) {
      expect(() => assert(slug, "0")).not.toThrow();
    }
  });

  it("treats a stated 0 as a floor, not as an absent one", () => {
    // A channel the CUSTOMER operates spends none of our money.
    expect(minimums.minimumFor("your-team-meeting-booking")).toBe(0);
    expect(() => assert("your-team-meeting-booking", "1")).not.toThrow();
  });
});

describe("a channel the published terms do not price", () => {
  it("is refused BY NAME, at any amount including 0", () => {
    expect(() => assert("carrier-pigeon-outreach", "10000")).toThrow(
      UnknownAcquisitionChannelError
    );
    expect(() => assert("carrier-pigeon-outreach", "0")).toThrow(
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

describe("the grandfather", () => {
  // A channel carried over below its floor may be kept or raised, never lowered
  // to another funded sub-minimum value.
  const gf = (value: number, stored: number | null) =>
    assert(COLD, String(value), stored === null ? null : String(stored));

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
    expect(() => gf(400, 500)).toThrow(CeilingBelowMinimumError);
  });

  it("spends the grandfather once the ceiling reaches the floor", () => {
    expect(() => gf(800, 500)).not.toThrow();
    expect(() => gf(500, 800)).toThrow(CeilingBelowMinimumError);
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
});
