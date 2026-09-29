/**
 * The prepaid / postpaid money paths an MRR / one-off / cash-flow split will be
 * built on. Audit of 2026-09-29, one regression per confirmed defect:
 *
 *  1. A Revolut org has NO Stripe customer by design; its completed top-ups and
 *     its saved card must still reach the balance and credited_paid.
 *  2. Switching to prepaid without a chargeable card leaves auto top-up OFF, and
 *     the month-end sweep's unpaid-debt metric counts only orgs actually flagged.
 *  3. Every settle (month-end, switch to prepaid, card change, the charge
 *     schedule's month-end event) charges ACTUAL usage, never a provisioned hold.
 *  4. A negative postpaid org with a card and auto top-up OFF is charged at
 *     month end.
 *  5. The payment outlook's budget totals include a brand funded only by the
 *     global sales budget.
 *  6. A young org's realized burn is not diluted by days before it existed.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { billingAccounts, brandSalesBudgets } from "../../src/db/schema.js";
import { _resetCoalescer } from "../../src/lib/reload-coalescer.js";
import { computeBalance } from "../../src/lib/balance.js";
import { setPaymentMode } from "../../src/lib/payment-mode.js";
import { runMonthEndSweep, SWEEP_HOUR_UTC } from "../../src/lib/month-end-sweep.js";
import { settleOutstandingBeforeCardChange } from "../../src/lib/card-change-settlement.js";
import { replayCharges } from "../../src/lib/charge-schedule.js";
import {
  BURN_WINDOW_DAYS,
  effectiveBurnWindowDays,
  fetchRealizedDailyBurn,
} from "../../src/lib/realized-burn.js";

const orgId = "00000000-0000-0000-0000-00000000a0d1";
const userId = "00000000-0000-0000-0000-00000000a0d9";
const brandId = "00000000-0000-0000-0000-00000000a0b1";
const campaignId = "00000000-0000-0000-0000-00000000a0c1";
const LAST_DAY = new Date(Date.UTC(2026, 0, 31, SWEEP_HOUR_UTC, 0, 0));

describe("money-path audit 2026-09-29", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  /** Projected usage (actual + provisioned holds) — what the spendable balance subtracts. */
  let projected = "0.0000000000";
  /** Actual usage only — what a settle charges against. */
  let actual = "0.0000000000";

  beforeEach(async () => {
    vi.restoreAllMocks();
    _resetCoalescer();
    await cleanTestData();
    projected = "0.0000000000";
    actual = "0.0000000000";

    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("owner@client.test"));
    ssMocks.fetchOrgCustomerOrNull.mockResolvedValue(customerWithEmail("owner@client.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("FR");

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: projected,
      as_of: "2026-09-29T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async () => ({
      spent_cents: actual,
    }));
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  // ── 1. Revolut org ────────────────────────────────────────────────────────

  it("1: a Revolut org's completed top-up reaches its balance (no Stripe customer)", async () => {
    // A Revolut org: stripe-service holds no Stripe customer for it, but its
    // payment summary and payment-method reads answer from Revolut.
    ssMocks.fetchOrgCustomerOrNull.mockResolvedValue(null);
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("5000.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue(null);

    const snapshot = await computeBalance(orgId);
    expect(snapshot.paidTopupsCents).toBe("5000.0000000000");
    expect(snapshot.creditedCents).toBe("5000.0000000000");
    expect(snapshot.balanceCents).toBe("5000.0000000000");
    expect(snapshot.hasCardPm).toBe(true);
  });

  it("1: GET /v1/accounts shows a Revolut org's payment in credited_paid and its card", async () => {
    await insertTestAccount({ orgId });
    ssMocks.getCustomerByOrgOrNull.mockResolvedValue(null);
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("5000.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);

    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId, userId));

    expect(res.status).toBe(200);
    expect(res.body.credited_paid_cents).toBe("5000.0000000000");
    expect(Number(res.body.credited_cents)).toBeGreaterThanOrEqual(5000);
    expect(res.body.has_payment_method).toBe(true);
  });

  // ── 2. Prepaid switch + unpaid-debt metric ───────────────────────────────

  it("2: switching to prepaid WITHOUT a chargeable card leaves auto top-up off", async () => {
    await insertTestAccount({ orgId });
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue(null);

    const state = await setPaymentMode(orgId, "prepaid");

    expect(state.paymentMode).toBe("prepaid");
    expect(state.autoTopupEnabled).toBe(false);
    const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(row.topupAmountCents).toBeNull();
  });

  it("2: switching to prepaid WITH a chargeable card arms auto top-up", async () => {
    await insertTestAccount({ orgId });

    const state = await setPaymentMode(orgId, "prepaid");

    expect(state.autoTopupEnabled).toBe(true);
  });

  it("2: a prepaid org owing with no card is NOT counted as an unpaid debt", async () => {
    await insertTestAccount({ orgId, paymentMode: "prepaid", topupAmountCents: 5000, topupThresholdCents: 0 });
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
    projected = "300.0000000000";
    actual = "300.0000000000";

    const res = await runMonthEndSweep(LAST_DAY);

    expect(res.eligible).toBe(1);
    expect(res.unpaidDebt).toBe(0);
    expect(res.skipped).toBe(1);
  });

  // ── 3. Settles charge actual usage only ──────────────────────────────────

  it("3: the month-end sweep charges actual usage, not provisioned holds", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 200 });
    projected = "500.0000000000"; // 100 actual + 400 held
    actual = "100.0000000000";

    const res = await runMonthEndSweep(LAST_DAY);

    expect(res.charged).toBe(1);
    expect(ssMocks.reloadOffSession.mock.calls[0]?.[1]).toBe(100);
  });

  it("3: the month-end sweep charges nothing when only holds put the balance below zero", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 200 });
    projected = "500.0000000000";
    actual = "0.0000000000";

    const res = await runMonthEndSweep(LAST_DAY);

    expect(res.charged).toBe(0);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("3: the switch to prepaid settles actual usage, not holds", async () => {
    await insertTestAccount({ orgId });
    projected = "900.0000000000";
    actual = "250.0000000000";
    const onDemand = await import("../../src/lib/on-demand-charge.js");
    const charge = vi
      .spyOn(onDemand, "chargeOrgOnDemand")
      .mockResolvedValue({ reference: "ch_1" } as never);

    const state = await setPaymentMode(orgId, "prepaid");

    expect(charge).toHaveBeenCalledWith(orgId, 250);
    expect(state.settledCents).toBe("250");
  });

  it("3: the card-change settle charges actual usage, not holds", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 200 });
    projected = "700.0000000000";
    actual = "120.0000000000";

    const outcome = await settleOutstandingBeforeCardChange(orgId);

    expect(outcome.result).toBe("charged");
    expect(outcome.chargedCents).toBe(120);
    expect(ssMocks.reloadOffSession.mock.calls[0]?.[1]).toBe(120);
  });

  it("3: the charge schedule's month-end event settles actual usage, not holds", () => {
    // Spendable −500 (actual −100, 400 held), no burn: the month-end settle is 100.
    const events = replayCharges({
      now: new Date(Date.UTC(2026, 0, 10)),
      end: new Date(Date.UTC(2026, 1, 5)),
      balanceCents: "-500.0000000000",
      settleBalanceCents: "-100.0000000000",
      paidTopupsCents: "0",
      requiredCents: "0",
      dailyBurnCents: "0",
      paymentMode: "postpaid",
      dueNow: false,
    });

    const monthEnd = events.filter((e) => e.trigger === "month_end");
    expect(monthEnd).toHaveLength(1);
    expect(monthEnd[0]?.expectedAmountCents).toBe("100");
  });

  // ── 4. Postpaid, card, auto top-up OFF ───────────────────────────────────

  it("4: a negative postpaid org with a card and auto top-up OFF is charged at month end", async () => {
    await insertTestAccount({ orgId }); // postpaid, topupAmountCents null → auto top-up off
    projected = "340.0000000000";
    actual = "340.0000000000";

    const res = await runMonthEndSweep(LAST_DAY);

    expect(res.eligible).toBe(1);
    expect(res.charged).toBe(1);
    expect(ssMocks.reloadOffSession.mock.calls[0]?.[1]).toBe(340);
  });

  it("4: the outlook dates that org's month-end settle instead of saying no_autopay", async () => {
    await insertTestAccount({ orgId });
    projected = "340.0000000000";
    actual = "340.0000000000";
    const campaignClient = await import("../../src/lib/campaign-service-client.js");
    vi.spyOn(campaignClient, "fetchSpendableBudget").mockResolvedValue(null);
    const burn = await import("../../src/lib/realized-burn.js");
    vi.spyOn(burn, "fetchRealizedDailyBurn").mockResolvedValue({
      dailyCents: "0.0000000000",
      unavailableReason: null,
      windowDays: 14,
    });

    const res = await request(app)
      .get(`/internal/accounts/by-org/${orgId}/payment-outlook`)
      .set({ "X-API-Key": "test-api-key" });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("will_charge");
    expect(res.body.trigger).toBe("month_end");
  });

  it("4: a prepaid org with auto top-up off is still NOT swept", async () => {
    await insertTestAccount({ orgId, paymentMode: "prepaid" });
    projected = "340.0000000000";
    actual = "340.0000000000";

    const res = await runMonthEndSweep(LAST_DAY);

    expect(res.eligible).toBe(0);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  // ── 5. Global sales budget in the outlook totals ─────────────────────────

  it("5: the outlook's budget totals include a brand funded only by the global sales budget", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 200 });
    await db.insert(brandSalesBudgets).values({
      orgId,
      brandId,
      dailyBudgetCents: "2500.0000000000",
    });
    const campaignClient = await import("../../src/lib/campaign-service-client.js");
    vi.spyOn(campaignClient, "fetchSpendableBudget").mockResolvedValue({
      orgId,
      brandId,
      grain: "campaign",
      configuredDailyBudgetCents: 0,
      runningDailyBudgetCents: 0,
      campaigns: [
        {
          campaignId,
          status: "ongoing",
          running: true,
          featureSlug: "cold-email",
          offerId: null,
          legKey: null,
          configuredDailyBudgetCents: 0,
          runningDailyBudgetCents: 0,
        },
      ],
      rows: [],
    });
    const burn = await import("../../src/lib/realized-burn.js");
    vi.spyOn(burn, "fetchRealizedDailyBurn").mockResolvedValue({
      dailyCents: "0.0000000000",
      unavailableReason: null,
      windowDays: 14,
    });

    const res = await request(app)
      .get(`/internal/accounts/by-org/${orgId}/payment-outlook`)
      .set({ "X-API-Key": "test-api-key" });

    expect(res.status).toBe(200);
    expect(Number(res.body.configuredDailyBudgetCents)).toBe(2500);
    expect(Number(res.body.runningDailyBudgetCents)).toBe(2500);
  });

  // ── 6. Realized burn for a young org ─────────────────────────────────────

  it("6: a young org's burn is divided by the days it has existed, not fourteen", async () => {
    const now = new Date(Date.UTC(2026, 8, 29, 12));
    const createdAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 2 days old
    expect(effectiveBurnWindowDays(now, createdAt)).toBe(2);
    expect(effectiveBurnWindowDays(now, new Date(Date.UTC(2026, 0, 1)))).toBe(BURN_WINDOW_DAYS);

    process.env.RUNS_COST_SOURCE_FILTER = "costSource=platform";
    process.env.RUNS_SERVICE_URL ??= "http://runs.test";
    process.env.RUNS_SERVICE_API_KEY ??= "runs-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          buckets: [
            { period: "2026-09-28", netActualCostInUsdCents: "600", netProvisionedCostInUsdCents: "0" },
            { period: "2026-09-29", netActualCostInUsdCents: "400", netProvisionedCostInUsdCents: "0" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    try {
      const burn = await fetchRealizedDailyBurn(orgId, now, createdAt);
      expect(burn.windowDays).toBe(2);
      expect(Number(burn.dailyCents)).toBe(500);
      const url = String(fetchSpy.mock.calls[0]?.[0]);
      expect(url).toContain(`startedAfter=${encodeURIComponent(createdAt.toISOString())}`);
    } finally {
      delete process.env.RUNS_COST_SOURCE_FILTER;
    }
  });
});
