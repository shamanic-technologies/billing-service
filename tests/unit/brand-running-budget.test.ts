import { describe, it, expect } from "vitest";
import {
  brandGrainChange,
  ceilingChangesBetween,
} from "../../src/lib/brand-running-budget.js";

const RUNNING_STORED = { featureSlug: "sales-cold-email-outreach", offerId: null };
const RUNNING = { featureSlug: "sales-cold-email-outreach", offerId: null, legKey: null };
const PAUSED = { featureSlug: "feedback-request-cold-email-outreach", offerId: null, legKey: null };
const PAUSED_STORED = {
  featureSlug: "feedback-request-cold-email-outreach",
  offerId: null,
};

describe("ceilingChangesBetween", () => {
  const stored = (
    grain: { featureSlug: string; offerId: string | null; legKey?: string | null },
    cents: string
  ) => ({ legKey: null, ...grain, dailyBudgetCents: cents });

  it("reports opened, moved and deleted ceilings, and skips unchanged ones", () => {
    const changes = ceilingChangesBetween(
      [
        stored(RUNNING_STORED, "20000.0000000000"),
        stored(PAUSED_STORED, "1000.0000000000"),
      ],
      [
        stored(RUNNING_STORED, "21000.0000000000"),
        stored({ featureSlug: "google-ads", offerId: null }, "500.0000000000"),
      ]
    );

    expect(changes).toHaveLength(3);
    expect(
      changes.find((c) => c.featureSlug === RUNNING.featureSlug)
    ).toMatchObject({
      previousDailyBudgetCents: "20000.0000000000",
      newDailyBudgetCents: "21000.0000000000",
    });
    expect(
      changes.find((c) => c.featureSlug === PAUSED.featureSlug)
    ).toMatchObject({ newDailyBudgetCents: "0" });
    expect(changes.find((c) => c.featureSlug === "google-ads")).toMatchObject({
      previousDailyBudgetCents: "0",
    });
  });

  it("treats a re-save of the same value as no change", () => {
    expect(
      ceilingChangesBetween(
        [stored(RUNNING_STORED, "5000.0000000000")],
        [stored(RUNNING_STORED, "5000")]
      )
    ).toEqual([]);
  });

  it("diffs two LEGS of one (channel, offer) apart", () => {
    // Billing stores one ceiling per campaign, so two legs must not collapse into
    // one change, and each delta applies to its own leg's running verdict.
    const leg = (legKey: string, cents: string) => ({
      ...RUNNING_STORED,
      legKey,
      dailyBudgetCents: cents,
    });

    const changes = ceilingChangesBetween(
      [leg("first_touch", "12000"), leg("follow_up", "8000")],
      [leg("first_touch", "13000"), leg("follow_up", "8000")]
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      featureSlug: RUNNING.featureSlug,
      offerId: null,
      legKey: "first_touch",
      previousDailyBudgetCents: "12000",
      newDailyBudgetCents: "13000",
    });

    const both = ceilingChangesBetween(
      [leg("first_touch", "12000"), leg("follow_up", "8000")],
      [leg("first_touch", "13000"), leg("follow_up", "9000")]
    );
    expect(both).toHaveLength(2);
  });

  it("distinguishes an offer-scoped ceiling from the unscoped one", () => {
    const offerId = "d5ecba00-0000-4000-8000-000000000001";
    const changes = ceilingChangesBetween(
      [stored(RUNNING_STORED, "4000")],
      [stored({ ...RUNNING_STORED, offerId }, "4000")]
    );

    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.offerId).sort()).toEqual([offerId, null]);
  });
});

describe("brandGrainChange", () => {
  it("names every grain field null, the way campaign-service names that ceiling", () => {
    expect(brandGrainChange("5000", "9900")).toEqual([
      {
        featureSlug: null,
        offerId: null,
        legKey: null,
        previousDailyBudgetCents: "5000",
        newDailyBudgetCents: "9900",
      },
    ]);
  });

  it("reads a first-ever set as coming from zero, and a re-save as no change", () => {
    expect(brandGrainChange(null, "5000")[0].previousDailyBudgetCents).toBe("0");
    expect(brandGrainChange("5000", "5000.0000000000")).toEqual([]);
  });
});
