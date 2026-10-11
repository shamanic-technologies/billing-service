import { describe, it, expect } from "vitest";
import { decideRunway } from "../../src/lib/runway.js";

const now = new Date("2026-10-11T12:00:00.000Z");
const base = {
  orgId: "11111111-1111-1111-1111-111111111111",
  paymentMode: "prepaid" as const,
  configuredDailyBudgetCents: "2000",
  now,
};

describe("decideRunway", () => {
  it("states whole days left and the run-out instant", () => {
    const r = decideRunway({ ...base, balanceCents: "14230.0000000000", dailyBudgetCents: "1200" });
    expect(r.state).toBe("days");
    expect(r.daysLeft).toBe(11);
    expect(r.daysLeftExact).toBe("11.85");
    // 14230 / 1200 days = 1,024,560,000 ms
    expect(r.runsOutAt).toBe(new Date(now.getTime() + 1_024_560_000).toISOString());
  });

  it("less than a day reads 0 days, still state days", () => {
    const r = decideRunway({ ...base, balanceCents: "500", dailyBudgetCents: "1000" });
    expect(r.state).toBe("days");
    expect(r.daysLeft).toBe(0);
    expect(r.runsOutAt).toBe("2026-10-12T00:00:00.000Z");
  });

  it("balance at or under zero is depleted, whatever the budget", () => {
    expect(decideRunway({ ...base, balanceCents: "0", dailyBudgetCents: "1000" }).state).toBe("depleted");
    expect(decideRunway({ ...base, balanceCents: "-12.5", dailyBudgetCents: null }).state).toBe("depleted");
  });

  it("no running budget is no_budget, with no number", () => {
    const r = decideRunway({ ...base, balanceCents: "5000", dailyBudgetCents: "0" });
    expect(r.state).toBe("no_budget");
    expect(r.daysLeft).toBeNull();
    expect(r.runsOutAt).toBeNull();
  });

  it("unreadable running budget is budget_unavailable, never a guess", () => {
    expect(decideRunway({ ...base, balanceCents: "5000", dailyBudgetCents: null }).state).toBe(
      "budget_unavailable"
    );
  });

  it("postpaid and subscription orgs are not_prepaid", () => {
    for (const paymentMode of ["postpaid", "subscription"] as const) {
      const r = decideRunway({ ...base, paymentMode, balanceCents: "5000", dailyBudgetCents: "1000" });
      expect(r.state).toBe("not_prepaid");
      expect(r.daysLeft).toBeNull();
    }
  });
});
