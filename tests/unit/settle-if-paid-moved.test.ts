import { describe, it, expect, vi, beforeEach } from "vitest";

const ensureWelcomePromise = vi.fn(async () => {});
const settleReferralsEarnedBy = vi.fn(async () => ({ granted: [] }));
const settleWelcomeCompletion = vi.fn(async () => ({ granted: true, amountCents: "7000", reason: "granted" }));

vi.mock("../../src/lib/free-credit-promises.js", () => ({ ensureWelcomePromise, settleReferralsEarnedBy }));
vi.mock("../../src/lib/welcome-completion.js", () => ({ settleWelcomeCompletion }));

const { settleFreeCreditPromisesIfPaidMoved, resetSettleMemoForTests } = await import(
  "../../src/lib/free-credit-settlement.js"
);

describe("account read settles only when the paid sum moved (MON-DB-HOT-1112)", () => {
  beforeEach(() => {
    resetSettleMemoForTests();
    settleWelcomeCompletion.mockClear();
  });

  it("first read settles, a read with the same paid sum skips, a payment settles again", async () => {
    const a = await settleFreeCreditPromisesIfPaidMoved("org-1", "10000");
    expect(a.grantedCents).toBe("7000.0000000000");
    const b = await settleFreeCreditPromisesIfPaidMoved("org-1", "10000.0000000000");
    expect(b.grantedCents).toBe("0.0000000000");
    expect(settleWelcomeCompletion).toHaveBeenCalledTimes(1);
    await settleFreeCreditPromisesIfPaidMoved("org-1", "15000");
    expect(settleWelcomeCompletion).toHaveBeenCalledTimes(2);
  });

  it("concurrent reads of one org share one settle and only one reports the grant", async () => {
    const rs = await Promise.all(
      Array.from({ length: 40 }, () => settleFreeCreditPromisesIfPaidMoved("org-2", "500"))
    );
    expect(settleWelcomeCompletion).toHaveBeenCalledTimes(1);
    expect(rs.filter((r) => r.grantedCents !== "0.0000000000")).toHaveLength(1);
  });

  it("a settle that throws is not memoised: the next read retries", async () => {
    settleWelcomeCompletion.mockRejectedValueOnce(new Error("boom"));
    await expect(settleFreeCreditPromisesIfPaidMoved("org-3", "100")).rejects.toThrow("boom");
    await settleFreeCreditPromisesIfPaidMoved("org-3", "100");
    expect(settleWelcomeCompletion).toHaveBeenCalledTimes(2);
  });
});
