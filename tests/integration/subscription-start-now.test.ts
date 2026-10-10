/**
 * START NOW (owner 2026-10-03; lib/subscription `startSubscriptionNow`). A customer
 * in the free trial ends it early and pays today, at the current amount or any
 * other ladder value. Pins:
 *   - the read offers it while trialing AND on an active plan (upgrade now, owner
 *     2026-10-10: higher amount only, charged today, cycle restarts today);
 *   - PATCH without start_now on a trialing plan is still 409 subscription_trialing
 *     (no charge is ever implicit);
 *   - start_now: charged today at the chosen amount, active, trial ended now, next
 *     charge one month out, the credit grew by the amount, the trial credit kept;
 *   - nothing is charged when the old trial end passes;
 *   - a declined card / an outage: nothing changes, still trialing at the old amount;
 *   - the per-plan route does the same for one plan;
 *   - revenue: the plan is recurring once started.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { subscriptionCharges, subscriptionCreditExpiries } from "../../src/db/schema.js";
import {
  advanceSubscription,
  getLiveSubscription,
  startSubscription,
} from "../../src/lib/subscription.js";
import { nextPeriodEnd } from "../../src/lib/subscription-schedule.js";
import { getOrgRevenue } from "../../src/lib/revenue.js";

const orgId = "00000000-0000-0000-0000-0000000007b1";
const userId = "00000000-0000-0000-0000-0000000007b9";
const headers = getAuthHeaders(orgId, userId);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const REVOLUT_CARD = {
  object: "saved_payment_method",
  org_id: orgId,
  acquirer: "revolut",
  saved: true,
  method: { id: "rpm_1", type: "card", saved_for: "merchant" },
};

describe("subscription: start a trialing plan now", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let paid = 0;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    paid = 0;

    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@new.test"));
    // stripe-service counts every succeeded charge as a paid top-up.
    ssMocks.sumSucceededTopupsForOrg.mockImplementation(async () => `${paid}.0000000000`);
    ssMocks.reloadOffSession.mockImplementation(async (_org: string, amount: number) => {
      paid += amount;
      return { status: "succeeded", reference: "pi_mock" };
    });
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");
    ssMocks.getSavedPaymentMethod.mockResolvedValue(REVOLUT_CARD);

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: "1000.0000000000",
      as_of: "2026-10-01T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: "1000.0000000000",
      as_of: "2026-10-01T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue("00000000-0000-0000-0000-00000000a001");
    vi.spyOn(runsClient, "completePlatformRun").mockResolvedValue(undefined);
    const cs = await import("../../src/lib/campaign-service-client.js");
    vi.spyOn(cs, "fetchSpendableBudget").mockResolvedValue(null);
    vi.spyOn(cs, "fetchRecurringCampaignStatuses").mockResolvedValue({ ok: true, campaigns: [] });
    const burn = await import("../../src/lib/realized-burn.js");
    vi.spyOn(burn, "fetchRealizedDailyBurn").mockResolvedValue({
      dailyCents: "1000.0000000000",
      unavailableReason: null,
      windowDays: 14,
    });
    const email = await import("../../src/lib/email-client.js");
    vi.spyOn(email, "sendEmail").mockImplementation(vi.fn());
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  async function startTrial(amount = 9900) {
    await insertTestAccount({ orgId });
    return startSubscription({ orgId, userId, monthlyAmountCents: amount });
  }

  it("the read offers start-now while trialing; PATCH without start_now still refuses", async () => {
    await startTrial();
    const read = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(read.body.subscription).toMatchObject({
      status: "trialing",
      can_start_now: true,
      can_change_amount: false,
    });
    const res = await request(app)
      .patch("/v1/accounts/subscription")
      .set(headers)
      .send({ monthly_amount_cents: 19900 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("subscription_trialing");
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("start now at the SAME amount: charged today, active, period restarts, the trial-ending payment adds no credit", async () => {
    const trial = await startTrial(9900);
    // Trial credit $99, $10 spent → $89 left before paying.
    const before = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(before.body.credits_remaining_cents).toBe("8900.0000000000");

    const t0 = Date.now();
    const res = await request(app)
      .patch("/v1/accounts/subscription")
      .set(headers)
      .send({ monthly_amount_cents: 9900, start_now: true });
    expect(res.status).toBe(200);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(9900);
    expect(res.body.subscription).toMatchObject({
      status: "active",
      monthly_amount_cents: 9900,
      // Active: start-now is the UPGRADE NOW (a higher amount only).
      can_start_now: true,
      can_change_amount: true,
    });
    const start = new Date(res.body.subscription.current_period_start);
    expect(start.getTime()).toBeGreaterThanOrEqual(t0);
    expect(start.getTime()).toBeLessThan(trial.trialEndsAt!.getTime());
    expect(res.body.subscription.trial_end).toBe(res.body.subscription.current_period_start);
    expect(res.body.subscription.next_charge_at).toBe(nextPeriodEnd(start, start).toISOString());
    // The payment that ends the trial repays the $99 trial credit and adds none
    // (owner 2026-10-06): the $89 left of the trial is the first month's credit.
    expect(res.body.credits_remaining_cents).toBe("8900.0000000000");
    const expiries = await db
      .select()
      .from(subscriptionCreditExpiries)
      .where(eq(subscriptionCreditExpiries.orgId, orgId));
    expect(expiries).toHaveLength(0);
  });

  it("start now at a DIFFERENT amount; nothing is charged when the old trial end passes", async () => {
    const trial = await startTrial(9900);
    const res = await request(app)
      .patch("/v1/accounts/subscription")
      .set(headers)
      .send({ monthly_amount_cents: 29900, start_now: true });
    expect(res.status).toBe(200);
    expect(res.body.subscription).toMatchObject({ status: "active", monthly_amount_cents: 29900 });
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(29900);

    const live = (await getLiveSubscription(orgId))!;
    const after = await advanceSubscription(live, new Date(trial.trialEndsAt!.getTime() + HOUR));
    expect(after.status).toBe("active");
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);

    // Revenue: a paying plan now, at its new amount.
    const rev = await getOrgRevenue(orgId);
    expect(rev!.revenueClass).toBe("recurring");
    expect(rev!.subscription!.monthlyAmountCents).toBe(29900);
  });

  it("declined card: 409 first_charge_declined, still trialing at the old amount, no credit", async () => {
    const trial = await startTrial(9900);
    ssMocks.reloadOffSession.mockResolvedValue({ status: "failed", failure_code: "insufficient_funds" });
    const res = await request(app)
      .patch("/v1/accounts/subscription")
      .set(headers)
      .send({ monthly_amount_cents: 19900, start_now: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("first_charge_declined");
    const read = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(read.body.subscription).toMatchObject({
      status: "trialing",
      monthly_amount_cents: 9900,
      trial_end: trial.trialEndsAt!.toISOString(),
      can_start_now: true,
    });
    expect(read.body.credits_remaining_cents).toBe("8900.0000000000");

    // The customer can try again (another card) and it goes through.
    ssMocks.reloadOffSession.mockImplementation(async (_o: string, amount: number) => {
      paid += amount;
      return { status: "succeeded", reference: "pi_mock2" };
    });
    const retry = await request(app)
      .patch("/v1/accounts/subscription")
      .set(headers)
      .send({ monthly_amount_cents: 19900, start_now: true });
    expect(retry.status).toBe(200);
    expect(retry.body.subscription.status).toBe("active");
    // Two attempts, two distinct charges: the retry never replays the refused key.
    const keys = ssMocks.reloadOffSession.mock.calls.map((c) => c[2]);
    expect(new Set(keys).size).toBe(2);
  });

  it("an outage: 502 charge_unavailable, nothing changes", async () => {
    await startTrial(9900);
    ssMocks.reloadOffSession.mockRejectedValue(new Error("stripe-service POST charge failed: 503"));
    const res = await request(app)
      .patch("/v1/accounts/subscription")
      .set(headers)
      .send({ monthly_amount_cents: 9900, start_now: true });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("charge_unavailable");
    expect((await getLiveSubscription(orgId))!.status).toBe("trialing");
  });

  it("refusals: active plan at the same amount → amount_not_upgrade; cancel pending → subscription_cancel_pending; no card → card_required", async () => {
    await startTrial(9900);
    await request(app).post("/v1/accounts/subscription/cancel").set(headers);
    let res = await request(app)
      .patch("/v1/accounts/subscription")
      .set(headers)
      .send({ monthly_amount_cents: 9900, start_now: true });
    expect(res.body.code).toBe("subscription_cancel_pending");
    await request(app).post("/v1/accounts/subscription/resume").set(headers);

    ssMocks.authorizeRecurringCharges.mockResolvedValue({ authorized: false, reason: "no_card" });
    res = await request(app)
      .patch("/v1/accounts/subscription")
      .set(headers)
      .send({ monthly_amount_cents: 9900, start_now: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("card_required");
    ssMocks.authorizeRecurringCharges.mockResolvedValue({ authorized: true });

    res = await request(app)
      .patch("/v1/accounts/subscription")
      .set(headers)
      .send({ monthly_amount_cents: 9900, start_now: true });
    expect(res.status).toBe(200);
    res = await request(app)
      .patch("/v1/accounts/subscription")
      .set(headers)
      .send({ monthly_amount_cents: 9900, start_now: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("amount_not_upgrade");
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
  });

  it("UPGRADE NOW on an active plan: charged today at the new amount, credited at once, cycle restarts today", async () => {
    const trial = await startTrial(9900);
    // Trial ends: the first $99 repays the trial credit (adds none).
    let live = (await getLiveSubscription(orgId))!;
    live = await advanceSubscription(live, new Date(trial.trialEndsAt!.getTime() + HOUR));
    expect(live.status).toBe("active");
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    const before = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(before.body.subscription.can_start_now).toBe(true);
    const balanceBefore = Number(before.body.credits_remaining_cents);

    // A lower amount is never charged today.
    let res = await request(app)
      .patch("/v1/accounts/subscription")
      .set(headers)
      .send({ monthly_amount_cents: 4900, start_now: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("amount_not_upgrade");

    const t0 = Date.now();
    res = await request(app)
      .patch("/v1/accounts/subscription")
      .set(headers)
      .send({ monthly_amount_cents: 29900, start_now: true });
    expect(res.status).toBe(200);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(2);
    expect(ssMocks.reloadOffSession.mock.calls[1][1]).toBe(29900);
    expect(res.body.subscription).toMatchObject({ status: "active", monthly_amount_cents: 29900 });
    // The trial end stays where it was: only the period restarts.
    expect(res.body.subscription.trial_end).toBe(live.trialEndsAt!.toISOString());
    const start = new Date(res.body.subscription.current_period_start);
    expect(start.getTime()).toBeGreaterThanOrEqual(t0);
    expect(res.body.subscription.next_charge_at).toBe(nextPeriodEnd(start, start).toISOString());
    // Credited at once: the whole $299 lands on top of what was left.
    expect(Number(res.body.credits_remaining_cents)).toBe(balanceBefore + 29900);
    // Nothing expired early.
    const expiries = await db
      .select()
      .from(subscriptionCreditExpiries)
      .where(eq(subscriptionCreditExpiries.orgId, orgId));
    expect(expiries.filter((e) => e.boundaryAt.getTime() >= t0)).toHaveLength(0);

    // A second click at the amount just paid charges nothing.
    res = await request(app)
      .patch("/v1/accounts/subscription")
      .set(headers)
      .send({ monthly_amount_cents: 29900, start_now: true });
    expect(res.body.code).toBe("amount_not_upgrade");
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(2);
  });

  it("per-plan route starts that plan now", async () => {
    const trial = await startTrial(9900);
    const res = await request(app)
      .patch(`/v1/accounts/subscriptions/${trial.id}`)
      .set(headers)
      .send({ monthly_amount_cents: 19900, start_now: true });
    expect(res.status).toBe(200);
    expect(res.body.subscription).toMatchObject({ id: trial.id, status: "active", monthly_amount_cents: 19900 });
    const charges = await db
      .select()
      .from(subscriptionCharges)
      .where(eq(subscriptionCharges.subscriptionId, trial.id));
    expect(charges.filter((c) => c.status === "paid")).toHaveLength(1);
    expect(charges[0].periodEnd.getTime() - charges[0].periodStart.getTime()).toBeGreaterThan(27 * DAY);
  });
});
