/**
 * Every automatic charge billing expects over a horizon (lib/charge-schedule),
 * built on the payment outlook's own decision.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertTestAccount,
  } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";

const orgId = "00000000-0000-0000-0000-0000000000e1";
const unknownOrgId = "00000000-0000-0000-0000-0000000000e9";

const apiKeyHeaders = { "X-API-Key": "test-api-key" };

function schedulePath(id: string) {
  return `/internal/accounts/by-org/${id}/charge-schedule`;
}
function outlookPath(id: string) {
  return `/internal/accounts/by-org/${id}/payment-outlook`;
}

/** Everything ever credited. Paid topups only, so the tier resolves off it. */
const PAID = "25000.0000000000";
/**
 * The floor $250 of cumulative paid topups resolves to. The postpaid tier is
 * DERIVED from paid topups and never stored, so a fixture that picks a paid
 * figure has picked a floor along with it — $250 is at or above the $200 rung.
 */
const FLOOR = "-20000";

describe("GET /internal/accounts/by-org/:orgId/charge-schedule", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let setUsage: (cents: string) => void;
  let burnMock: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();

    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@acme.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(PAID);
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");

    const runsClient = await import("../../src/lib/runs-client.js");
    let usage = "0.0000000000";
    setUsage = (cents: string) => {
      usage = cents;
    };
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage,
      as_of: "2026-09-18T00:00:00.000Z",
    }));
    // Settles charge ACTUAL usage only; with no holds in these fixtures it
    // equals the projected usage above.
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(
      async () => ({ spent_cents: usage })
    );

    // campaign-service is fail-soft by design; default it to unreachable so the
    // cases below assert the degraded shape unless they say otherwise.
    const campaignClient = await import("../../src/lib/campaign-service-client.js");
    vi.spyOn(campaignClient, "fetchSpendableBudget").mockResolvedValue(null);

    const burn = await import("../../src/lib/realized-burn.js");
    burnMock = vi.spyOn(burn, "fetchRealizedDailyBurn");
    burnMock.mockResolvedValue({
      dailyCents: "1000.0000000000", // $10/day
      unavailableReason: null,
      windowDays: 14,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("404s for an org with no billing account, 400s on a bad orgId or horizon", async () => {
    expect((await request(app).get(schedulePath(unknownOrgId)).set(apiKeyHeaders)).status).toBe(404);
    expect((await request(app).get(schedulePath("nope")).set(apiKeyHeaders)).status).toBe(400);
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    for (const h of ["0", "367", "1.5", "abc"]) {
      const res = await request(app).get(`${schedulePath(orgId)}?horizonDays=${h}`).set(apiKeyHeaders);
      expect(res.status).toBe(400);
    }
  });

  it("no auto-topup, PREPAID: says so, and lists NO automatic charge", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: null,
      topupThresholdCents: null,
      paymentMode: "prepaid",
    });
    setUsage("30000.0000000000"); // owes $50 — a prepaid org is never charged automatically

    const res = await request(app).get(schedulePath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("no_autopay");
    expect(res.body.events).toEqual([]);
    expect(res.body.expectedTotalCents).toBe("0");
    expect(res.body.horizonDays).toBe(90);
  });

  it("no auto-topup, POSTPAID with a card: the month-end sweep settles what it owes, once", async () => {
    await insertTestAccount({ orgId, topupAmountCents: null, topupThresholdCents: null });
    setUsage("30000.0000000000"); // owes $50

    const res = await request(app).get(schedulePath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("will_charge");
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].trigger).toBe("month_end");
    expect(res.body.events[0].expectedAmountCents).toBe("5000");
    expect(res.body.expectedTotalCents).toBe("5000");
  });

  it("an org that owes: month-end settles what is owed then, and the schedule agrees with the outlook", async () => {
    // Pin "now": the two reads below must see the same instant to date the same charge.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    setUsage("25741.0000000000"); // balance −741
    burnMock.mockResolvedValue({ dailyCents: "681.0000000000", unavailableReason: null, windowDays: 14 });

    const res = await request(app).get(`${schedulePath(orgId)}?horizonDays=120`).set(apiKeyHeaders);
    const outlook = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("will_charge");
    expect(res.body.floorCents).toBe(FLOOR);
    expect(res.body.events.length).toBeGreaterThan(1);
    const first = res.body.events[0];
    // The first event is the outlook's next charge, same trigger, same instant.
    expect(first.trigger).toBe(outlook.body.trigger);
    expect(first.at).toBe(outlook.body.nextChargeAttemptAt);
    expect(first.trigger).toBe("month_end");
    // Owed at month end = 741 + burn to that date: never a whole month of burn.
    expect(Number(first.expectedAmountCents)).toBeGreaterThan(741);
    expect(Number(first.expectedAmountCents)).toBeLessThan(741 + 681 * 32);
    expect(res.body.events.some((e: { trigger: string }) => e.trigger === "floor")).toBe(true);
    const total = res.body.events.reduce(
      (s: number, e: { expectedAmountCents: string }) => s + Number(e.expectedAmountCents),
      0
    );
    expect(res.body.expectedTotalCents).toBe(String(total));
  });

  it("unmeasured burn: the owed month-end settle is listed with a NULL amount, never a guess", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    setUsage("25741.0000000000");
    burnMock.mockResolvedValue({
      dailyCents: null,
      unavailableReason: "platform_only_dated_spend_not_served",
      windowDays: 14,
    });

    const res = await request(app).get(schedulePath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("unknown");
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({ trigger: "month_end", expectedAmountCents: null });
    expect(res.body.expectedTotalCents).toBeNull();
  });

  it("no chargeable card: charge_blocked, no events", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
    setUsage("25741.0000000000");

    const res = await request(app).get(schedulePath(orgId)).set(apiKeyHeaders);

    expect(res.body.state).toBe("charge_blocked");
    expect(res.body.blockedReason).toBe("no_chargeable_card");
    expect(res.body.events).toEqual([]);
  });
});
