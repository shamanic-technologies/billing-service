/**
 * The two grains this service serves above the stored one: the per-FUNNEL figure
 * and the brand-wide figure, each a sum of what sits underneath. Composed HERE
 * and only here — a consumer that adds the channels up itself is a consumer that
 * will one day disagree with this service.
 */
import { describe, it, expect } from "vitest";
import {
  aggregateFunnelTotals,
  funnelTotalOf,
  sumFunnelBudgets,
  assertFundedChannelMeetsMinimum,
  channelTotalOf,
  FunnelBudgetBelowMinimumError,
} from "../../src/lib/brand-funnel-budgets.js";
import type { BrandFunnelDailyBudget } from "../../src/db/schema.js";

const row = (
  funnelKey: string,
  featureSlug: string,
  cents: string,
  updatedAt: string
): BrandFunnelDailyBudget => ({
  orgId: "00000000-0000-0000-0000-000000000001",
  brandId: "00000000-0000-0000-0000-000000000002",
  funnelKey,
  featureSlug,
  dailyBudgetCents: cents,
  updatedAt: new Date(updatedAt),
});

describe("per-funnel totals over acquisition channels", () => {
  it("sums a funnel's channels and takes the latest timestamp", () => {
    const totals = aggregateFunnelTotals([
      row("reply_meeting", "sales-cold-email-outreach", "3000.0000000000", "2026-08-01T00:00:00Z"),
      row("reply_meeting", "feedback-request-cold-email-outreach", "2000.0000000000", "2026-08-05T00:00:00Z"),
      row("visit_form", "sales-cold-email-outreach", "100.0000000000", "2026-07-01T00:00:00Z"),
    ]);

    expect(totals.map((t) => [t.funnelKey, t.dailyBudgetCents])).toEqual([
      ["reply_meeting", "5000.0000000000"],
      ["visit_form", "100.0000000000"],
    ]);
    expect(totals[0].updatedAt.toISOString()).toBe("2026-08-05T00:00:00.000Z");
  });

  it("is byte-identical to the stored row when a funnel has one channel", () => {
    const rows = [
      row("visit_form", "sales-cold-email-outreach", "800.0000000000", "2026-08-01T00:00:00Z"),
    ];
    const [total] = aggregateFunnelTotals(rows);
    expect(total.dailyBudgetCents).toBe(rows[0].dailyBudgetCents);
    expect(total.updatedAt).toEqual(rows[0].updatedAt);
    expect(sumFunnelBudgets(rows)).toBe("800.0000000000");
  });

  it("reads one funnel's total, and 0 for a funnel it does not fund", () => {
    const rows = [
      row("reply_meeting", "a", "1200.0000000000", "2026-08-01T00:00:00Z"),
      row("reply_meeting", "b", "1200.0000000000", "2026-08-01T00:00:00Z"),
    ];
    expect(funnelTotalOf(rows, "reply_meeting")).toBe("2400.0000000000");
    expect(funnelTotalOf(rows, "visit_form")).toBe("0.0000000000");
  });

  it("judges the minimum on the CHANNEL total, not on a single offer", () => {
    // $12 + $12 of two offers on ONE channel = the $24/day floor: accepted.
    const COLD = "sales-cold-email-outreach";
    expect(() =>
      assertFundedChannelMeetsMinimum(
        "reply_meeting",
        COLD,
        "2400.0000000000",
        null
      )
    ).not.toThrow();
    expect(() =>
      assertFundedChannelMeetsMinimum(
        "reply_meeting",
        COLD,
        "1200.0000000000",
        null
      )
    ).toThrow(FunnelBudgetBelowMinimumError);
  });

  it("sums one (funnel, channel) pair's offers and nothing else", () => {
    const rows = [
      row("reply_meeting", "sales-cold-email-outreach", "1200.0000000000", "2026-08-01T00:00:00Z"),
      row("reply_meeting", "sales-cold-email-outreach", "1200.0000000000", "2026-08-01T00:00:00Z"),
      row("reply_meeting", "google-ads", "500.0000000000", "2026-08-01T00:00:00Z"),
    ];
    // Two rows for one pair only differ by offer in the stored table; the pair's
    // total is what the floor binds.
    expect(
      channelTotalOf(rows, "reply_meeting", "sales-cold-email-outreach")
    ).toBe("2400.0000000000");
    expect(channelTotalOf(rows, "reply_meeting", "google-ads")).toBe(
      "500.0000000000"
    );
    expect(channelTotalOf(rows, "visit_form", "google-ads")).toBe(
      "0.0000000000"
    );
  });

  it("does not grandfather a channel whose stored total already cleared the floor", () => {
    expect(() =>
      assertFundedChannelMeetsMinimum(
        "reply_meeting",
        "sales-cold-email-outreach",
        "1200.0000000000",
        "2400.0000000000"
      )
    ).toThrow(FunnelBudgetBelowMinimumError);
  });
});
