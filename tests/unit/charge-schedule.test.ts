import { describe, it, expect } from "vitest";
import { replayCharges } from "../../src/lib/charge-schedule.js";

const DAY = 24 * 60 * 60 * 1000;

/**
 * The prod case this exists for (Shockwavecenters, 2026-09-28): owes $7.41,
 * burns ~$6.81/day, $200 floor. A consumer guessing "burn × 30 on the 1st"
 * showed a $204 inflow on 1 Oct; the real month-end charge is ~$33 and the
 * floor is reached around 30 Oct.
 */
describe("replayCharges", () => {
  const now = new Date("2026-09-27T04:00:00.000Z");

  it("month-end settles ONLY what is owed by then, then the floor reload follows", () => {
    const events = replayCharges({
      now,
      end: new Date(now.getTime() + 90 * DAY),
      balanceCents: "-741",
      paidTopupsCents: "25000", // ≥ $200 paid ⇒ $200 line
      requiredCents: "100",
      dailyBurnCents: "681",
      paymentMode: "postpaid",
      dueNow: false,
    });

    const [first, second, third] = events;
    expect(first.trigger).toBe("month_end");
    expect(first.at).toBe("2026-09-30T23:00:00.000Z");
    // 741 owed + 3.79 days × 681 ≈ 3323, never a month of burn.
    const firstAmount = Number(first.expectedAmountCents);
    expect(firstAmount).toBeGreaterThan(3200);
    expect(firstAmount).toBeLessThan(3400);
    expect(Number(first.projectedBalanceAfterCents)).toBeGreaterThanOrEqual(0);

    expect(second.trigger).toBe("floor");
    expect(second.expectedAmountCents).toBe("20000");
    expect(second.at.startsWith("2026-10-30")).toBe(true);

    // The month-end after the reload settles the day or so of burn since.
    expect(third.trigger).toBe("month_end");
    expect(third.at).toBe("2026-10-31T23:00:00.000Z");
    expect(Number(third.expectedAmountCents)).toBeLessThan(2000);

    for (const e of events) {
      expect(new Date(e.at).getTime()).toBeLessThanOrEqual(now.getTime() + 90 * DAY);
    }
  });

  it("a positive balance that never goes negative is never charged at month end", () => {
    const events = replayCharges({
      now,
      end: new Date(now.getTime() + 20 * DAY),
      balanceCents: "100000",
      paidTopupsCents: "25000",
      requiredCents: "0",
      dailyBurnCents: "100",
      paymentMode: "postpaid",
      dueNow: false,
    });
    expect(events).toEqual([]);
  });

  it("zero burn: an owed balance is settled once, then nothing", () => {
    const events = replayCharges({
      now,
      end: new Date(now.getTime() + 90 * DAY),
      balanceCents: "-1000",
      paidTopupsCents: "25000",
      requiredCents: "0",
      dailyBurnCents: "0",
      paymentMode: "postpaid",
      dueNow: false,
    });
    expect(events.map((e) => [e.trigger, e.expectedAmountCents])).toEqual([
      ["month_end", "1000"],
    ]);
  });

  it("due now: the reload is presented at now first", () => {
    const events = replayCharges({
      now,
      end: new Date(now.getTime() + 2 * DAY),
      balanceCents: "-5000",
      paidTopupsCents: "1000", // < $200 ⇒ $50 line
      requiredCents: "92",
      dailyBurnCents: "0",
      paymentMode: "postpaid",
      dueNow: true,
    });
    expect(events[0]).toMatchObject({
      at: now.toISOString(),
      trigger: "floor",
      expectedAmountCents: "5000",
    });
  });

  it("the tier grows as charges accumulate, so the floor moves with it", () => {
    // $150 paid ⇒ $50 line; the first $50 reload takes paid to $200 ⇒ $200 line.
    const events = replayCharges({
      now,
      end: new Date(now.getTime() + 60 * DAY),
      balanceCents: "0",
      paidTopupsCents: "15000",
      requiredCents: "0",
      dailyBurnCents: "2000",
      paymentMode: "postpaid",
      dueNow: false,
    });
    const floors = events.filter((e) => e.trigger === "floor");
    expect(floors[0].expectedAmountCents).toBe("5000");
    expect(floors.slice(1).every((e) => e.expectedAmountCents === "20000")).toBe(true);
  });

  it("prepaid: reloads at a zero floor, never a month-end settle", () => {
    const events = replayCharges({
      now,
      end: new Date(now.getTime() + 30 * DAY),
      balanceCents: "3000",
      paidTopupsCents: "5000",
      requiredCents: "50",
      dailyBurnCents: "500",
      paymentMode: "prepaid",
      dueNow: false,
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.trigger === "floor")).toBe(true);
    for (const e of events) {
      expect(Number(e.projectedBalanceBeforeCents)).toBeGreaterThanOrEqual(0);
    }
  });
});
