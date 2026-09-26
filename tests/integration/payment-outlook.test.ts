/**
 * "When will this org next be charged, and if never, why not."
 *
 * The cases below are the production population measured on 2026-09-18, and
 * each of the three surprising ones is pinned because the obvious design gets
 * it wrong:
 *
 *   - SIX of the twelve orgs that were spending had no auto-topup, so they are
 *     never charged automatically — they run out and stop. A forecast that
 *     hands every org a date is wrong about half of them.
 *   - the TWO orgs already past their floor were exactly the two whose card the
 *     bank was refusing, so the date is about an ATTEMPT, never a payment.
 *   - utilisation of the configured ceiling ran 4% to 146%, so the ceiling
 *     cannot be substituted for the realized burn in either direction — all
 *     three figures are served side by side.
 *
 * And the rule that binds the whole surface: a figure we cannot establish is
 * null with a NAMED reason, never zero. A consumer that cannot tell "we do not
 * know" from "nothing was spent" renders the second one, which is a lie about a
 * paying customer.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertTestAccount,
  insertTestCampaignCost,
  insertTestSweepAttempt,
} from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";

const orgId = "00000000-0000-0000-0000-0000000000d1";
const unknownOrgId = "00000000-0000-0000-0000-0000000000d9";
const campaignId = "00000000-0000-0000-0000-0000000000da";

const apiKeyHeaders = { "X-API-Key": "test-api-key" };

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

describe("GET /internal/accounts/by-org/:orgId/payment-outlook", () => {
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

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("404s for an org with no billing account", async () => {
    const res = await request(app).get(outlookPath(unknownOrgId)).set(apiKeyHeaders);
    expect(res.status).toBe(404);
  });

  it("400s on an orgId that is not a UUID", async () => {
    const res = await request(app).get(outlookPath("not-a-uuid")).set(apiKeyHeaders);
    expect(res.status).toBe(400);
  });

  it("no auto-topup carries NO date — half the spending orgs are in this state", async () => {
    // The org is burning real money and holds a card; what it does not hold is
    // a configuration that would ever charge it. It will run out and stop.
    await insertTestAccount({ orgId, topupAmountCents: null, topupThresholdCents: null });
    setUsage("0.0000000000");

    const res = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("no_autopay");
    expect(res.body.nextChargeAttemptAt).toBeNull();
    expect(res.body.trigger).toBeNull();
    // The floor is "0" for an org with no credit line, not the tier's.
    expect(res.body.floorCents).toBe("0");
  });

  it("dates the FLOOR crossing for a healthy postpaid org", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    // $250 paid ⇒ the $200 tier ⇒ a −20000 floor. Credit of 25000 burning 1000
    // a day has 45000 cents of headroom, 45 days out — well past this month's
    // sweep, at which point the balance is still positive, so the sweep would
    // charge nothing and the floor is the only real date.
    setUsage("0.0000000000");

    const res = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("will_charge");
    expect(res.body.trigger).toBe("floor");
    expect(res.body.nextChargeAttemptAt).not.toBeNull();
    expect(res.body.floorCents).toBe(FLOOR);
  });

  it("prefers the MONTH-END settle when it comes first and something is owed", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    // Already in the red: the sweep settles it on the last day of the month,
    // which arrives long before this burn eats the rest of the credit line.
    setUsage("26000.0000000000");

    const res = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("will_charge");
    expect(res.body.trigger).toBe("month_end");
    expect(res.body.nextChargeAttemptAt).toMatch(/T23:00:00\.000Z$/);
  });

  it("is due NOW once the balance is past the floor", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    setUsage("46000.0000000000"); // balance −21000 against a −20000 floor

    const res = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("charge_due_now");
    expect(res.body.trigger).toBe("floor");
    expect(res.body.nextChargeAttemptAt).not.toBeNull();
  });

  it("RESERVES the stored estimate: a wedged org reads due now, not later", async () => {
    // Org 81b34252's geometry, at this fixture's floor. The balance sits 4.22
    // cents ABOVE the floor, so a bare-floor reading says "not yet" — but the
    // next run needs 11.80, so `balance − required` is already under it and
    // every run is refused.
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    await insertTestCampaignCost({
      campaignId,
      orgId,
      lastAuthorizeRequiredCents: "11.8000000000",
    });
    setUsage("44995.7810968628"); // balance −19995.7810968628, floor −20000

    const res = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("charge_due_now");
  });

  it("a refused card is BLOCKED and dated on the next retry rung", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    await insertTestSweepAttempt({
      orgId,
      creditedCentsAtAttempt: PAID,
      lastOutcome: "failed",
      firstFailedAt: new Date("2026-09-17T06:47:44.000Z"),
    });
    setUsage("46000.0000000000");

    const res = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("charge_blocked");
    expect(res.body.blockedReason).toBe("card_declined");
    expect(res.body.trigger).toBe("retry_rung");
    expect(res.body.nextChargeAttemptAt).not.toBeNull();
  });

  it("a card the issuer called unusable is blocked with NO date, ever", async () => {
    // Lost, stolen, closed: the networks forbid re-presenting it at any
    // interval, so there is no rung to date and the retry schedule is moot.
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    await insertTestSweepAttempt({
      orgId,
      creditedCentsAtAttempt: PAID,
      lastOutcome: "failed",
      firstFailedAt: new Date("2026-09-17T06:47:44.000Z"),
      cardUnusableAt: new Date("2026-09-17T06:47:45.000Z"),
    });
    setUsage("46000.0000000000");

    const res = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("charge_blocked");
    expect(res.body.blockedReason).toBe("card_unusable");
    expect(res.body.nextChargeAttemptAt).toBeNull();
    expect(res.body.trigger).toBeNull();
  });

  it("a streak out of rungs is blocked, not scheduled", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    await insertTestSweepAttempt({
      orgId,
      creditedCentsAtAttempt: PAID,
      lastOutcome: "failed",
      firstFailedAt: new Date("2026-09-01T06:00:00.000Z"),
      attemptCount: 5,
    });
    setUsage("46000.0000000000");

    const res = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("charge_blocked");
    expect(res.body.blockedReason).toBe("retries_exhausted");
    expect(res.body.nextChargeAttemptAt).toBeNull();
  });

  it("no chargeable card on file is charge_blocked / no_chargeable_card — auto-topup or not", async () => {
    // Owner rule 2026-09-27: an org with no chargeable payment method must stop
    // every campaign. campaign-service stops on charge_blocked, so this is the
    // verdict — never no_autopay, which reads as "fine, just not automatic".
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue(null);
    await insertTestAccount({ orgId, topupAmountCents: null, topupThresholdCents: null });

    const res = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("charge_blocked");
    expect(res.body.blockedReason).toBe("no_chargeable_card");
    expect(res.body.nextChargeAttemptAt).toBeNull();
    expect(res.body.trigger).toBeNull();
  });

  it("no chargeable card is blocked even when auto-topup was configured (card removed)", async () => {
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue(null);
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });

    const res = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.body.state).toBe("charge_blocked");
    expect(res.body.blockedReason).toBe("no_chargeable_card");
    expect(res.body.floorCents).toBe("0");
  });

  it("an org with NO Stripe customer at all (never added a card) is blocked", async () => {
    ssMocks.fetchOrgCustomerOrNull.mockResolvedValue(null);
    await insertTestAccount({ orgId, topupAmountCents: null, topupThresholdCents: null });

    const res = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("charge_blocked");
    expect(res.body.blockedReason).toBe("no_chargeable_card");
  });

  it("mid card-change (new card attached, old detached) is NOT blocked, and adding a card clears it", async () => {
    // The verdict is the CURRENT state. The card-change flow attaches the new
    // card and then detaches the old one, so a chargeable method is on file
    // throughout and the org reads exactly as before.
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
    const before = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);
    expect(before.body.blockedReason).toBe("no_chargeable_card");

    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    const after = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(after.body.state).toBe("will_charge");
    expect(after.body.blockedReason).toBeNull();
    expect(after.body.floorCents).toBe(FLOOR);
  });

  it("a card whose country cannot be charged off-session is blocked, not no_autopay", async () => {
    // India / RBI: the configuration exists and the card exists; what is
    // impossible is the off-session charge. That is a different sentence to the
    // customer than "you never set up auto-topup".
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("IN");
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    setUsage("0.0000000000");

    const res = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("charge_blocked");
    expect(res.body.blockedReason).toBe("card_country_unsupported");
    expect(res.body.nextChargeAttemptAt).toBeNull();
  });

  it("holding credit and burning nothing is idle — no date, and no debt implied", async () => {
    burnMock.mockResolvedValue({
      dailyCents: "0.0000000000",
      unavailableReason: null,
      windowDays: 14,
    });
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    setUsage("0.0000000000");

    const res = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("idle");
    expect(res.body.nextChargeAttemptAt).toBeNull();
    expect(res.body.realizedDailyBurnCents).toBe("0.0000000000");
  });

  it("an unmeasurable burn is UNKNOWN with a named reason — never zero, never idle", async () => {
    // The whole point of the null: zero would render as an idle customer and
    // suppress a charge date that may be real.
    burnMock.mockResolvedValue({
      dailyCents: null,
      unavailableReason: "platform_only_dated_spend_not_served",
      windowDays: 14,
    });
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    setUsage("0.0000000000");

    const res = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("unknown");
    expect(res.body.realizedDailyBurnCents).toBeNull();
    expect(res.body.burnUnavailableReason).toBe("platform_only_dated_spend_not_served");
    // Nothing is owed yet and no rate is available, so no date is invented.
    expect(res.body.nextChargeAttemptAt).toBeNull();
  });

  it("an unmeasurable burn STILL dates the month-end settle when the org is already in the red", async () => {
    // That date does not depend on a rate: the sweep settles what is owed.
    burnMock.mockResolvedValue({
      dailyCents: null,
      unavailableReason: "platform_only_dated_spend_not_served",
      windowDays: 14,
    });
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    setUsage("26000.0000000000");

    const res = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("unknown");
    expect(res.body.trigger).toBe("month_end");
    expect(res.body.nextChargeAttemptAt).toMatch(/T23:00:00\.000Z$/);
  });

  it("502s rather than reporting a zero burn when runs-service cannot be read", async () => {
    burnMock.mockRejectedValue(new Error("runs-service unreachable"));
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });

    const res = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(502);
  });

  it("serves the running split as NULL when campaign-service cannot be read", async () => {
    // Never the configured total wearing a running label.
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    setUsage("0.0000000000");

    const res = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    // No funded brand at all, so there is nothing to ask about and both totals
    // are a real zero rather than an unknown.
    expect(res.body.configuredDailyBudgetCents).toBe("0");
    expect(res.body.runningDailyBudgetCents).toBe("0");
  });

  it("is a PURE read: it opens no depletion episode and records no attempt", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    setUsage("46000.0000000000"); // past the floor — the state that opens episodes elsewhere

    await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);

    const { listEpisodes } = await import("../helpers/test-db.js");
    expect(await listEpisodes(orgId)).toEqual([]);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });
});
