import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  cleanTestData,
  insertTestAccount,
  closeDb,
} from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import {
  runMonthEndSweep,
  monthBucket,
  sweepIdempotencyKey,
} from "../../src/lib/month-end-sweep.js";

// A last calendar day of the month (UTC) — the sweep trigger. Jan 31.
const LAST_DAY = new Date(Date.UTC(2026, 0, 31, 12, 0, 0));
// A non-last day — the sweep must no-op.
const MID_MONTH = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));

const orgA = "00000000-0000-0000-0000-00000000f001";
const orgB = "00000000-0000-0000-0000-00000000f002";
const billingEmail = "founder@acme.test";

describe("Month-end forced top-up sweep", () => {
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let setUsage: (orgId: string, cents: string) => void;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail(billingEmail));
    await cleanTestData();

    // balance = credited − usage. credited = paidTopups (no promos here).
    // paidTopups is driven per-test via sumSucceededTopupsForOrg; usage per-org
    // via this map so two orgs can carry different balances in one sweep.
    const usageByOrg = new Map<string, string>();
    setUsage = (orgId: string, cents: string) => usageByOrg.set(orgId, cents);
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(
      async (orgId: string) => ({
        org_id: orgId,
        spent_cents: usageByOrg.get(orgId) ?? "0.0000000000",
        as_of: "2026-01-31T00:00:00.000Z",
      })
    );
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("AC1: charges a reload-capable, enabled org with a negative balance", async () => {
    await insertTestAccount({
      orgId: orgA,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    // paid 0 → tier amount 5000. usage 100 → balance -100 → settle to >= 0.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    setUsage(orgA, "100.0000000000");

    const res = await runMonthEndSweep(LAST_DAY);

    expect(res.ranSweep).toBe(true);
    expect(res.eligible).toBe(1);
    expect(res.charged).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.failed).toBe(0);
    expect(ssMocks.reloadViaPaymentIntent).toHaveBeenCalledTimes(1);
    // One tier-amount multiple (5000) clears the -100 deficit to +4900.
    expect(ssMocks.reloadViaPaymentIntent.mock.calls[0]?.[1]).toBe(5000);
    // Month-scoped idempotency key.
    expect(ssMocks.reloadViaPaymentIntent.mock.calls[0]?.[2]).toBe(
      sweepIdempotencyKey(orgA, monthBucket(LAST_DAY))
    );
  });

  it("AC2: does NOT charge a non-negative balance", async () => {
    await insertTestAccount({
      orgId: orgA,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("100.0000000000");
    setUsage(orgA, "0.0000000000"); // balance +100

    const res = await runMonthEndSweep(LAST_DAY);

    expect(res.charged).toBe(0);
    expect(res.skipped).toBe(1);
    expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
  });

  it("AC2: does NOT charge an org with no chargeable card", async () => {
    await insertTestAccount({
      orgId: orgA,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    setUsage(orgA, "5000.0000000000"); // deeply negative

    const res = await runMonthEndSweep(LAST_DAY);

    expect(res.charged).toBe(0);
    expect(res.skipped).toBe(1);
    expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
  });

  it("AC2: does NOT charge a blocked-country (India) card", async () => {
    await insertTestAccount({
      orgId: orgA,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("IN");
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    setUsage(orgA, "5000.0000000000");

    const res = await runMonthEndSweep(LAST_DAY);

    expect(res.charged).toBe(0);
    expect(res.skipped).toBe(1);
    expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
  });

  it("AC2: does NOT select an org with no auto-topup config", async () => {
    await insertTestAccount({ orgId: orgA }); // topupAmountCents null → not enabled
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    setUsage(orgA, "5000.0000000000");

    const res = await runMonthEndSweep(LAST_DAY);

    expect(res.eligible).toBe(0);
    expect(res.charged).toBe(0);
    expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
  });

  it("AC3: idempotent — after the settle, a second tick reads non-negative and skips", async () => {
    await insertTestAccount({
      orgId: orgA,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    setUsage(orgA, "100.0000000000"); // balance -100

    const first = await runMonthEndSweep(LAST_DAY);
    expect(first.charged).toBe(1);

    // The $50 settle lands → credited rises past usage → balance non-negative.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("5000.0000000000");

    const second = await runMonthEndSweep(LAST_DAY);
    expect(second.charged).toBe(0);
    expect(second.skipped).toBe(1);
    // Exactly ONE charge across both ticks.
    expect(ssMocks.reloadViaPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("AC4: a per-org failure is isolated — the sweep continues for other orgs", async () => {
    await insertTestAccount({
      orgId: orgA,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    await insertTestAccount({
      orgId: orgB,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    // orgA's balance read throws; orgB is a healthy negative balance.
    ssMocks.fetchOrgCustomer.mockImplementation(async (orgId: string) => {
      if (orgId === orgA) throw new Error("stripe-service unreachable");
      return customerWithEmail(billingEmail);
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    setUsage(orgB, "100.0000000000");

    const res = await runMonthEndSweep(LAST_DAY);

    expect(res.eligible).toBe(2);
    expect(res.failed).toBe(1); // orgA
    expect(res.charged).toBe(1); // orgB still settled
    expect(ssMocks.reloadViaPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("AC5/AC6: no-op on any day that is not the last of the month", async () => {
    await insertTestAccount({
      orgId: orgA,
      topupAmountCents: 1000,
      topupThresholdCents: 500,
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    setUsage(orgA, "5000.0000000000"); // deeply negative — would charge on the last day

    const res = await runMonthEndSweep(MID_MONTH);

    expect(res.ranSweep).toBe(false);
    expect(res.eligible).toBe(0);
    expect(res.charged).toBe(0);
    expect(ssMocks.reloadViaPaymentIntent).not.toHaveBeenCalled();
  });
});
