/**
 * The offer is the finest grain a ceiling has: one (funnel, channel, offer) row
 * is exactly one campaign. Everything coarser is a SUM composed here and only
 * here, and a brand that has never funded an offer must be byte-identical to
 * what this service served before offers existed.
 */
import { describe, it, expect } from "vitest";
import {
  aggregateChannelTotals,
  aggregateFunnelTotals,
  funnelTotalOf,
  parseFunnelBudgetSet,
  InvalidFunnelSetError,
} from "../../src/lib/brand-funnel-budgets.js";
import type { BrandFunnelDailyBudget } from "../../src/db/schema.js";

const COLD = "sales-cold-email-outreach";
const FEEDBACK = "feedback-request-cold-email-outreach";
const OFFER_A = "11111111-1111-4111-8111-111111111111";
const OFFER_B = "22222222-2222-4222-8222-222222222222";

const row = (
  funnelKey: string,
  featureSlug: string,
  offerId: string | null,
  cents: string,
  updatedAt: string
): BrandFunnelDailyBudget => ({
  orgId: "00000000-0000-0000-0000-000000000001",
  brandId: "00000000-0000-0000-0000-000000000002",
  funnelKey,
  featureSlug,
  offerId,
  dailyBudgetCents: cents,
  updatedAt: new Date(updatedAt),
});

describe("per-channel and per-funnel totals over offers", () => {
  it("sums a channel's offers and takes the latest timestamp", () => {
    const channels = aggregateChannelTotals([
      row("reply_meeting", COLD, OFFER_A, "3000.0000000000", "2026-08-01T00:00:00Z"),
      row("reply_meeting", COLD, OFFER_B, "2000.0000000000", "2026-08-05T00:00:00Z"),
      row("reply_meeting", FEEDBACK, OFFER_A, "1000.0000000000", "2026-07-01T00:00:00Z"),
    ]);

    expect(
      channels.map((c) => [c.funnelKey, c.featureSlug, c.dailyBudgetCents])
    ).toEqual([
      ["reply_meeting", FEEDBACK, "1000.0000000000"],
      ["reply_meeting", COLD, "5000.0000000000"],
    ]);
    expect(channels[1].updatedAt.toISOString()).toBe("2026-08-05T00:00:00.000Z");
  });

  it("is byte-identical to the stored row when a channel funds one offer", () => {
    // The unscoped ceiling every brand carried before offers existed.
    const rows = [
      row("visit_form", COLD, null, "800.0000000000", "2026-08-01T00:00:00Z"),
    ];
    const [channel] = aggregateChannelTotals(rows);
    expect(channel.dailyBudgetCents).toBe(rows[0].dailyBudgetCents);
    expect(channel.updatedAt).toEqual(rows[0].updatedAt);

    const [funnel] = aggregateFunnelTotals(rows);
    expect(funnel.dailyBudgetCents).toBe(rows[0].dailyBudgetCents);
  });

  it("rolls two offers of one pair up through both coarser grains", () => {
    const rows = [
      row("visit_form", COLD, OFFER_A, "600.0000000000", "2026-08-01T00:00:00Z"),
      row("visit_form", COLD, OFFER_B, "400.0000000000", "2026-08-01T00:00:00Z"),
    ];
    expect(aggregateChannelTotals(rows)[0].dailyBudgetCents).toBe(
      "1000.0000000000"
    );
    expect(aggregateFunnelTotals(rows)[0].dailyBudgetCents).toBe(
      "1000.0000000000"
    );
    expect(funnelTotalOf(rows, "visit_form")).toBe("1000.0000000000");
  });

  it("keeps an unstated offer ABSENT, so it never reads as a stored null", () => {
    const [parsed] = parseFunnelBudgetSet([
      { funnelKey: "visit_form", dailyBudgetCents: 100 },
    ]);
    expect("offerId" in parsed).toBe(false);

    const [stated] = parseFunnelBudgetSet([
      { funnelKey: "visit_form", offerId: OFFER_A, dailyBudgetCents: 100 },
    ]);
    expect(stated.offerId).toBe(OFFER_A);
  });

  it("accepts one pair funded for two offers in a single set", () => {
    const parsed = parseFunnelBudgetSet([
      { funnelKey: "visit_form", featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 600 },
      { funnelKey: "visit_form", featureSlug: COLD, offerId: OFFER_B, dailyBudgetCents: 400 },
    ]);
    expect(parsed.map((p) => p.offerId)).toEqual([OFFER_A, OFFER_B]);
  });

  it("refuses the same offer twice on one pair", () => {
    expect(() =>
      parseFunnelBudgetSet([
        { funnelKey: "visit_form", featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 600 },
        { funnelKey: "visit_form", featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 400 },
      ])
    ).toThrow(InvalidFunnelSetError);
  });

  it("refuses one pair set both with and without an offer", () => {
    // The two entries address overlapping grains, so the set does not say which
    // ceiling the offer-less figure is meant to be.
    expect(() =>
      parseFunnelBudgetSet([
        { funnelKey: "visit_form", featureSlug: COLD, dailyBudgetCents: 600 },
        { funnelKey: "visit_form", featureSlug: COLD, offerId: OFFER_A, dailyBudgetCents: 400 },
      ])
    ).toThrow(/with and without an offer/);
  });

  it("refuses an offer that is not a UUID", () => {
    expect(() =>
      parseFunnelBudgetSet([
        { funnelKey: "visit_form", offerId: "the-summer-offer", dailyBudgetCents: 100 },
      ])
    ).toThrow(/offerId must be a valid offer UUID/);
  });

  it("still refuses one funnel set both with and without a channel", () => {
    expect(() =>
      parseFunnelBudgetSet([
        { funnelKey: "visit_form", dailyBudgetCents: 600 },
        { funnelKey: "visit_form", featureSlug: COLD, dailyBudgetCents: 400 },
      ])
    ).toThrow(/with and without an acquisition channel/);
  });
});
