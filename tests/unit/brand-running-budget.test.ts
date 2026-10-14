import { describe, it, expect } from "vitest";
import { brandGrainChange } from "../../src/lib/brand-running-budget.js";

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
