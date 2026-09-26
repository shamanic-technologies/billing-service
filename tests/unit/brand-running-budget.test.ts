import { describe, it, expect } from "vitest";
import {
  brandGrainChange,
  ceilingChangesBetween,
  runningTotalsFor,
  type CeilingChange,
} from "../../src/lib/brand-running-budget.js";
import type {
  SpendableBudget,
  SpendableBudgetCampaign,
  SpendableBudgetRow,
} from "../../src/lib/campaign-service-client.js";

// The prod shape this exists for (2026-08-31):
//   org b645207b-…, brand 75d7e3e8-…
//   reply_meeting / feedback-request-cold-email-outreach : $10/day, STOPPED
//   reply_meeting / sales-cold-email-outreach            : $200/day, ONGOING
// Note the trap: ceilings written before offers existed (offerId null) while a
// running campaign names one.
type Grain = {
  featureSlug: string | null;
  offerId: string | null;
  legKey: string | null;
};
const PAUSED: Grain = {
  featureSlug: "feedback-request-cold-email-outreach",
  offerId: null,
  legKey: null,
};
const RUNNING: Grain = {
  featureSlug: "sales-cold-email-outreach",
  offerId: null,
  legKey: null,
};

function row(
  grain: Grain,
  dailyBudgetCents: number,
  running: boolean
): SpendableBudgetRow {
  return {
    ...grain,
    resolvedOfferId: "d5ecba00-0000-4000-8000-000000000001",
    dailyBudgetCents,
    running,
    campaignId: running ? "c-running" : "c-stopped",
    campaignStatus: running ? "ongoing" : "stopped",
  };
}

function campaign(
  grain: Grain,
  dailyBudgetCents: number,
  running: boolean
): SpendableBudgetCampaign {
  return {
    campaignId: running ? "c-running" : "c-stopped",
    status: running ? "ongoing" : "stopped",
    running,
    ...grain,
    configuredDailyBudgetCents: dailyBudgetCents,
    runningDailyBudgetCents: running ? dailyBudgetCents : 0,
  };
}

function spendable(
  rows: SpendableBudgetRow[],
  campaigns: SpendableBudgetCampaign[] = []
): SpendableBudget {
  return {
    orgId: "b645207b-d8e9-40b0-9391-072b777cd9a9",
    brandId: "75d7e3e8-6926-4f85-a557-976895400666",
    grain: "channel",
    configuredDailyBudgetCents: rows.reduce(
      (sum, r) => sum + r.dailyBudgetCents,
      0
    ),
    runningDailyBudgetCents: rows
      .filter((r) => r.running)
      .reduce((sum, r) => sum + r.dailyBudgetCents, 0),
    campaigns,
    rows,
  };
}

function dollars(cents: string): number {
  return Number(cents) / 100;
}

describe("running daily budget for a brand-budget change", () => {
  it("reports only the ongoing campaign's money on both sides of a raise", () => {
    // $200 → $210 on the RUNNING channel; the paused $10 sits beside it.
    const after = spendable([
      row(PAUSED, 1000, false),
      row(RUNNING, 21000, true),
    ]);
    const changes: CeilingChange[] = [
      { ...RUNNING, previousDailyBudgetCents: "20000", newDailyBudgetCents: "21000" },
    ];

    const totals = runningTotalsFor(after, changes);

    expect(dollars(totals.runningBeforeCents)).toBe(200);
    expect(dollars(totals.runningNowCents)).toBe(210);
    // and the configured totals, which the notification states alongside, are
    // the $210 → $220 the old email reported as the headline.
    expect(after.configuredDailyBudgetCents).toBe(22000);
  });

  it("a change that only moves PAUSED money leaves the running figure unchanged", () => {
    const after = spendable([
      row(PAUSED, 2000, false),
      row(RUNNING, 20000, true),
    ]);
    const changes: CeilingChange[] = [
      { ...PAUSED, previousDailyBudgetCents: "1000", newDailyBudgetCents: "2000" },
    ];

    const totals = runningTotalsFor(after, changes);

    expect(totals.runningBeforeCents).toBe(totals.runningNowCents);
    expect(dollars(totals.runningNowCents)).toBe(200);
  });

  it("counts a ceiling written before offers existed (null offer id) as running", () => {
    // The whole population before migration 0037 looks like this: offerId null
    // on the ceiling, a real offer on the campaign. campaign-service resolves it
    // and says `running: true`; billing takes that verdict as given.
    const after = spendable([row(RUNNING, 5000, true)]);

    const totals = runningTotalsFor(after, [
      { ...RUNNING, previousDailyBudgetCents: "0", newDailyBudgetCents: "5000" },
    ]);

    expect(dollars(totals.runningBeforeCents)).toBe(0);
    expect(dollars(totals.runningNowCents)).toBe(50);
  });

  it("matches a stored ceiling on its leg: another leg's row is not its verdict", () => {
    // campaign-service builds `rows` from billing's own ceilings, one per
    // (channel, offer, leg). A change on one leg must read THAT row's verdict.
    const after = spendable([
      row({ ...RUNNING, legKey: "first_touch" }, 21000, true),
      row({ ...RUNNING, legKey: "follow_up" }, 1000, false),
    ]);

    const running = runningTotalsFor(after, [
      {
        ...RUNNING,
        legKey: "first_touch",
        previousDailyBudgetCents: "20000",
        newDailyBudgetCents: "21000",
      },
    ]);
    expect(dollars(running.runningBeforeCents)).toBe(200);

    const paused = runningTotalsFor(after, [
      {
        ...RUNNING,
        legKey: "follow_up",
        previousDailyBudgetCents: "500",
        newDailyBudgetCents: "1000",
      },
    ]);
    expect(dollars(paused.runningBeforeCents)).toBe(210); // stopped leg → no delta
  });

  it("resolves a DELETED ceiling against the campaigns the same response names", () => {
    // A ceiling removed by a replace-mode write leaves no row to carry a flag.
    // The stopped one changed no running figure; the ongoing one did.
    const afterPausedRemoved = spendable(
      [row(RUNNING, 20000, true)],
      [campaign(PAUSED, 1000, false), campaign(RUNNING, 20000, true)]
    );
    expect(
      dollars(
        runningTotalsFor(afterPausedRemoved, [
          { ...PAUSED, previousDailyBudgetCents: "1000", newDailyBudgetCents: "0" },
        ]).runningBeforeCents
      )
    ).toBe(200);

    const afterRunningRemoved = spendable(
      [row(PAUSED, 1000, false)],
      [campaign(PAUSED, 1000, false), campaign(RUNNING, 20000, true)]
    );
    expect(
      dollars(
        runningTotalsFor(afterRunningRemoved, [
          { ...RUNNING, previousDailyBudgetCents: "20000", newDailyBudgetCents: "0" },
        ]).runningBeforeCents
      )
    ).toBe(200);
  });

  it("a deleted ceiling no campaign names counts as not running", () => {
    const after = spendable([row(RUNNING, 20000, true)], [
      campaign(RUNNING, 20000, true),
    ]);

    const totals = runningTotalsFor(after, [
      { ...PAUSED, previousDailyBudgetCents: "1000", newDailyBudgetCents: "0" },
    ]);

    expect(dollars(totals.runningBeforeCents)).toBe(200);
  });

  it("never reports a negative running figure", () => {
    const after = spendable([row(RUNNING, 0, true)]);

    const totals = runningTotalsFor(after, [
      { ...RUNNING, previousDailyBudgetCents: "0", newDailyBudgetCents: "99999" },
    ]);

    expect(dollars(totals.runningBeforeCents)).toBe(0);
  });
});

const RUNNING_STORED = { featureSlug: "sales-cold-email-outreach", offerId: null };
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
    const after = spendable([
      row({ ...RUNNING, legKey: "first_touch" }, 13000, true),
      row({ ...RUNNING, legKey: "follow_up" }, 9000, true),
    ]);
    expect(dollars(runningTotalsFor(after, both).runningBeforeCents)).toBe(200);
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

  it("carries the brand-grain running verdict through to the figure", () => {
    const grain: Grain = { featureSlug: null, offerId: null, legKey: null };
    const after = spendable([row(grain, 9900, true)]);

    const totals = runningTotalsFor(after, brandGrainChange("5000", "9900"));

    expect(dollars(totals.runningBeforeCents)).toBe(50);
    expect(dollars(totals.runningNowCents)).toBe(99);
  });
});
