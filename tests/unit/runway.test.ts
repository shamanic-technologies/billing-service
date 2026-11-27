import { describe, it, expect } from "vitest";
import { decideRunway } from "../../src/lib/runway.js";

const now = new Date("2026-10-11T12:00:00.000Z");
const base = {
  orgId: "11111111-1111-1111-1111-111111111111",
  paymentMode: "prepaid" as const,
  configuredDailyBudgetCents: "2000",
  now,
};
// Spend measured at the budget, for cases about something else than the divisor.
const atBudget = (dailyBudgetCents: string | null) => ({ dailyBudgetCents, dailySpendCents: dailyBudgetCents });

describe("decideRunway", () => {
  it("states whole days left and the run-out instant", () => {
    const r = decideRunway({ ...base, balanceCents: "14230.0000000000", ...atBudget("1200") });
    expect(r.state).toBe("days");
    expect(r.daysLeft).toBe(11);
    expect(r.daysLeftExact).toBe("11.85");
    // 14230 / 1200 days = 1,024,560,000 ms
    expect(r.runsOutAt).toBe(new Date(now.getTime() + 1_024_560_000).toISOString());
  });

  it("less than a day reads 0 days, still state days", () => {
    const r = decideRunway({ ...base, balanceCents: "500", ...atBudget("1000") });
    expect(r.state).toBe("days");
    expect(r.daysLeft).toBe(0);
    expect(r.runsOutAt).toBe("2026-10-12T00:00:00.000Z");
  });

  it("balance at or under zero is depleted, whatever the budget", () => {
    expect(decideRunway({ ...base, balanceCents: "0", ...atBudget("1000") }).state).toBe("depleted");
    expect(decideRunway({ ...base, balanceCents: "-12.5", ...atBudget(null) }).state).toBe("depleted");
  });

  it("no running budget is no_budget, with no number", () => {
    const r = decideRunway({ ...base, balanceCents: "5000", ...atBudget("0") });
    expect(r.state).toBe("no_budget");
    expect(r.daysLeft).toBeNull();
    expect(r.runsOutAt).toBeNull();
  });

  it("unreadable running budget is budget_unavailable, never a guess", () => {
    expect(decideRunway({ ...base, balanceCents: "5000", ...atBudget(null) }).state).toBe(
      "budget_unavailable"
    );
  });

  it("postpaid and subscription orgs are not_prepaid", () => {
    for (const paymentMode of ["postpaid", "subscription"] as const) {
      const r = decideRunway({ ...base, paymentMode, balanceCents: "5000", ...atBudget("1000") });
      expect(r.state).toBe("not_prepaid");
      expect(r.daysLeft).toBeNull();
    }
  });

  // RUNWAY-REAL-SPEND-1126: the divisor is what the org REALLY spends a day,
  // never its budget (a ceiling). WriteBros 2026-11-26: $94.65 balance, $121/day
  // max budget, $4.62 spent that day, read "Runs out today".
  it("funded org: days on the measured spend, never on the max budget", () => {
    const r = decideRunway({
      ...base,
      balanceCents: "9465.2511798880",
      dailyBudgetCents: "12100.0000000000",
      dailySpendCents: "462.1522101120",
    });
    expect(r.state).toBe("days");
    expect(r.daysLeft).toBe(20);
    expect(r.daysLeftExact).toBe("20.48");
    expect(r.noFigureReason).toBeNull();
    expect(r.dailySpendCents).toBe("462.1522101120");
  });

  it("spend above the budget shortens the runway (the budget is no bound either way)", () => {
    const r = decideRunway({ ...base, balanceCents: "1002", dailyBudgetCents: "143", dailySpendCents: "211" });
    expect(r.state).toBe("days");
    expect(r.daysLeft).toBe(4);
  });

  it("unfunded org (a campaign on, nothing spent): no_budget + no_spend, never 0 days", () => {
    const r = decideRunway({ ...base, balanceCents: "9925", dailyBudgetCents: "12100", dailySpendCents: "0" });
    expect(r.state).toBe("no_budget");
    expect(r.noFigureReason).toBe("no_spend");
    expect(r.daysLeft).toBeNull();
    expect(r.runsOutAt).toBeNull();
  });

  it("unfunded org (nothing running): no_budget, spend not read", () => {
    const r = decideRunway({ ...base, balanceCents: "9925", dailyBudgetCents: "0", dailySpendCents: null });
    expect(r.state).toBe("no_budget");
    expect(r.noFigureReason).toBeNull();
    expect(r.daysLeft).toBeNull();
  });

  it("spend not measurable: budget_unavailable + burn_unavailable, never a guess", () => {
    const r = decideRunway({ ...base, balanceCents: "9925", dailyBudgetCents: "12100", dailySpendCents: null });
    expect(r.state).toBe("budget_unavailable");
    expect(r.noFigureReason).toBe("burn_unavailable");
    expect(r.daysLeft).toBeNull();
  });

  it("zero-balance org is depleted, whatever it spends", () => {
    const r = decideRunway({ ...base, balanceCents: "0", dailyBudgetCents: "12100", dailySpendCents: "462" });
    expect(r.state).toBe("depleted");
    expect(r.daysLeft).toBeNull();
    expect(r.noFigureReason).toBeNull();
  });

  it("serves only the closed state set the dashboard parses", () => {
    const allowed = new Set(["days", "depleted", "no_budget", "budget_unavailable", "not_prepaid"]);
    for (const [bal, budget, spend] of [
      ["100", "10", "5"],
      ["100", "10", "0"],
      ["100", "10", null],
      ["100", "0", null],
      ["0", "10", "5"],
      ["100", null, null],
    ] as const) {
      expect(allowed.has(decideRunway({ ...base, balanceCents: bal, dailyBudgetCents: budget, dailySpendCents: spend }).state)).toBe(true);
    }
  });
});
