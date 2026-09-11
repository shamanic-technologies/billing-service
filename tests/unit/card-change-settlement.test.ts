import { describe, it, expect } from "vitest";
import {
  cardChangeSettleIdempotencyKey,
  dayBucket,
} from "../../src/lib/card-change-settlement.js";
import { formatOwed } from "../../src/lib/unpaid-debt.js";

describe("card-change settle idempotency key", () => {
  const orgId = "00000000-0000-0000-0000-0000000000d1";

  it("is stable for the same org, day and amount, so a retry collapses", () => {
    const a = cardChangeSettleIdempotencyKey(orgId, "2026-01-31", 5000);
    const b = cardChangeSettleIdempotencyKey(orgId, "2026-01-31", 5000);
    expect(a).toBe(b);
  });

  it("carries the AMOUNT, so a different settle is never blocked by an old key", () => {
    // The acquirer rejects a replayed key whose parameters changed. An
    // amount-independent key makes a second, corrected charge impossible and
    // replays the first attempt's charge — the prod failure the month-end sweep
    // documents at length.
    expect(cardChangeSettleIdempotencyKey(orgId, "2026-01-31", 5000)).not.toBe(
      cardChangeSettleIdempotencyKey(orgId, "2026-01-31", 7000)
    );
  });

  it("carries the DAY, so the same amount can legitimately be settled again later", () => {
    expect(cardChangeSettleIdempotencyKey(orgId, "2026-01-31", 5000)).not.toBe(
      cardChangeSettleIdempotencyKey(orgId, "2026-02-07", 5000)
    );
  });

  it("scopes to the org", () => {
    expect(cardChangeSettleIdempotencyKey(orgId, "2026-01-31", 5000)).not.toBe(
      cardChangeSettleIdempotencyKey(
        "00000000-0000-0000-0000-0000000000d2",
        "2026-01-31",
        5000
      )
    );
  });

  it("buckets by UTC day", () => {
    expect(dayBucket(new Date(Date.UTC(2026, 0, 31, 23, 59, 59)))).toBe("2026-01-31");
    expect(dayBucket(new Date(Date.UTC(2026, 1, 1, 0, 0, 0)))).toBe("2026-02-01");
  });
});

describe("formatOwed", () => {
  it("states whole cents in dollars, never a ten-decimal internal figure", () => {
    expect(formatOwed("5000.0000000000")).toBe("$50.00");
    expect(formatOwed("1.0000000000")).toBe("$0.01");
    expect(formatOwed("0")).toBe("$0.00");
  });
});
