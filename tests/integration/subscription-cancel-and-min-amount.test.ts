/**
 * Owner rules 2026-10-03 (cancel-plan retention flow):
 *   - a CANCEL stops sending at once (not at period end): authorize/affordability
 *     refuse spend, the read says sending_stopped; resume restarts it;
 *   - a plan may carry any whole-dollar amount from $29 (amount change, start-now,
 *     checkout); 2800 is refused amount_below_minimum.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { subscriptions } from "../../src/db/schema.js";
import {
  addMonths,
  advanceSubscription,
  cancelSubscription,
  getLiveSubscription,
  getOrgSendingStopped,
  pauseSubscription,
  runSubscriptionSweep,
  startSubscription,
  unpauseSubscription,
} from "../../src/lib/subscription.js";
import { upsertCampaignAuthorizeCost } from "../../src/lib/campaign-costs.js";
import { getOrgRevenue } from "../../src/lib/revenue.js";

const orgId = "00000000-0000-0000-0000-0000000009b1";
const userId = "00000000-0000-0000-0000-0000000009b9";
const campaignId = "00000000-0000-0000-0000-0000000009c1";
const headers = getAuthHeaders(orgId, userId);
const DAY = 24 * 60 * 60 * 1000;

const REVOLUT_CARD = {
  object: "saved_payment_method",
  org_id: orgId,
  acquirer: "revolut",
  saved: true,
  method: { id: "rpm_1", type: "card", saved_for: "merchant" },
};

describe("subscription: cancel stops sending at once; any amount from $29", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let paid = 0;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    paid = 0;

    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@new.test"));
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

  async function startTrial(now?: Date) {
    await insertTestAccount({ orgId });
    return startSubscription({ orgId, userId, monthlyAmountCents: 9900, now });
  }

  async function startActive(now: Date) {
    const trial = await startTrial(new Date(now.getTime() - 4 * DAY));
    const active = await advanceSubscription(trial, now);
    expect(active.status).toBe("active");
    return active;
  }

  const afford = () => request(app).get(`/internal/campaigns/${campaignId}/affordability`).set(headers);

  it("cancel stops sending AT ONCE: affordability refuses, the read says so; resume restarts it", async () => {
    await startActive(new Date());
    await upsertCampaignAuthorizeCost(campaignId, orgId, "10.0000000000");
    expect((await afford()).body.affordable).toBe(true);
    const before = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(before.body).toMatchObject({ sending_stopped: false, sending_stopped_reason: null });

    const cancel = await request(app).post("/v1/accounts/subscription/cancel").set(headers);
    expect(cancel.status).toBe(200);
    expect(cancel.body).toMatchObject({ sending_stopped: true, sending_stopped_reason: "plan_canceled" });
    expect(cancel.body.subscription).toMatchObject({ status: "active", cancel_at_period_end: true, sending_stopped: true });
    expect((await afford()).body.affordable).toBe(false);
    expect(await getOrgSendingStopped(orgId)).toBe("plan_canceled");

    const read = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(read.body).toMatchObject({ sending_stopped: true, sending_stopped_reason: "plan_canceled" });

    const resume = await request(app).post("/v1/accounts/subscription/resume").set(headers);
    expect(resume.body).toMatchObject({ sending_stopped: false, sending_stopped_reason: null });
    expect((await afford()).body.affordable).toBe(true);
  });

  it("an ended plan keeps sending stopped", async () => {
    const now = new Date();
    const active = await startActive(now);
    await cancelSubscription(orgId, now);
    await advanceSubscription((await getLiveSubscription(orgId))!, new Date(active.currentPeriodEnd.getTime() + 1000));
    expect(await getLiveSubscription(orgId)).toBeNull();
    expect(await getOrgSendingStopped(orgId)).toBe("plan_canceled");
  });

  it("amount: 2900 and 4700 accepted, the next charge is that amount; 2800 refused amount_below_minimum", async () => {
    const now = new Date();
    const active = await startActive(now);

    let res = await request(app).patch("/v1/accounts/subscription").set(headers).send({ monthly_amount_cents: 2800 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("amount_below_minimum");
    res = await request(app).patch("/v1/accounts/subscription").set(headers).send({ monthly_amount_cents: 4750 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("amount_not_whole_dollars");

    res = await request(app).patch("/v1/accounts/subscription").set(headers).send({ monthly_amount_cents: 2900 });
    expect(res.status).toBe(200);
    expect(res.body.subscription.monthly_amount_cents).toBe(2900);
    res = await request(app).patch("/v1/accounts/subscription").set(headers).send({ monthly_amount_cents: 4700 });
    expect(res.status).toBe(200);
    expect(res.body.subscription).toMatchObject({ monthly_amount_cents: 4700, next_charge_at: active.currentPeriodEnd.toISOString() });

    const calls = ssMocks.reloadOffSession.mock.calls.length;
    await advanceSubscription((await getLiveSubscription(orgId))!, new Date(active.currentPeriodEnd.getTime() + 1000));
    expect(ssMocks.reloadOffSession.mock.calls.length).toBe(calls + 1);
    expect(ssMocks.reloadOffSession.mock.calls[calls][1]).toBe(4700);
  });

  it("a TRIALING plan accepting a stay-for-less amount is charged now at it (start_now from $29)", async () => {
    await startTrial();
    let res = await request(app)
      .patch("/v1/accounts/subscription")
      .set(headers)
      .send({ monthly_amount_cents: 2800, start_now: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("amount_below_minimum");
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();

    res = await request(app)
      .patch("/v1/accounts/subscription")
      .set(headers)
      .send({ monthly_amount_cents: 3900, start_now: true });
    expect(res.status).toBe(200);
    expect(res.body.subscription).toMatchObject({ status: "active", monthly_amount_cents: 3900 });
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(3900);
  });

  it("checkout accepts $29", async () => {
    await insertTestAccount({ orgId });
    ssMocks.getSavedPaymentMethod.mockResolvedValue({ ...REVOLUT_CARD, saved: true });
    const res = await request(app)
      .post("/v1/accounts/subscription/checkout_session")
      .set(headers)
      .send({ monthly_amount_cents: 2900 });
    expect(res.status).toBe(200);
    expect(res.body.monthly_amount_cents).toBe(2900);
  });
});
