/**
 * PAUSE ("I need a break"; lib/subscription `pauseSubscription` / `unpauseSubscription`).
 * Pins:
 *   - a trialing or active plan can be paused for 1, 2 or 3 months; the read says
 *     paused, until when, and where the next charge falls;
 *   - NO charge while paused, even long past the old period end;
 *   - sending stops: affordability refuses while every live plan is paused;
 *   - unpause: active again, the period pushed by the paused time, next charge stated;
 *   - the pause ends on its own at pause_ends_at (the sweep / any read);
 *   - refusals: ended (subscription_ended), cancel pending, already paused,
 *     not paused, bad months; amount change / start-now refused while paused;
 *   - revenue: a paused plan is not recurring.
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
  isOrgSpendingPaused,
  pauseSubscription,
  runSubscriptionSweep,
  startSubscription,
  unpauseSubscription,
} from "../../src/lib/subscription.js";
import { upsertCampaignAuthorizeCost } from "../../src/lib/campaign-costs.js";
import { getOrgRevenue } from "../../src/lib/revenue.js";

const orgId = "00000000-0000-0000-0000-0000000008b1";
const userId = "00000000-0000-0000-0000-0000000008b9";
const campaignId = "00000000-0000-0000-0000-0000000008c1";
const headers = getAuthHeaders(orgId, userId);
const DAY = 24 * 60 * 60 * 1000;

const REVOLUT_CARD = {
  object: "saved_payment_method",
  org_id: orgId,
  acquirer: "revolut",
  saved: true,
  method: { id: "rpm_1", type: "card", saved_for: "merchant" },
};

describe("subscription: pause and unpause", () => {
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

  /** An ACTIVE plan: trial started 4 days ago, its end billed. */
  async function startActive(now: Date) {
    const trial = await startTrial(new Date(now.getTime() - 4 * DAY));
    const active = await advanceSubscription(trial, now);
    expect(active.status).toBe("active");
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    return active;
  }

  it("a trialing plan is paused through the route; the read states it, until when, and the next charge", async () => {
    const trial = await startTrial();
    const before = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(before.body.subscription).toMatchObject({ can_pause: true, can_unpause: false, paused: false });

    const res = await request(app).post("/v1/accounts/subscription/pause").set(headers).send({ months: 2 });
    expect(res.status).toBe(200);
    const sub = res.body.subscription;
    expect(sub).toMatchObject({ status: "trialing", paused: true, can_pause: false, can_unpause: true });
    expect(sub.can_start_now).toBe(false);
    const pausedAt = new Date(sub.paused_at);
    const endsAt = new Date(sub.pause_ends_at);
    expect(endsAt.toISOString()).toBe(addMonths(pausedAt, 2).toISOString());
    // Next charge = pause end + the trial time left when paused.
    const left = trial.currentPeriodEnd.getTime() - pausedAt.getTime();
    expect(new Date(sub.next_charge_at).getTime()).toBe(endsAt.getTime() + left);

    const read = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(read.body.subscription.paused).toBe(true);
  });

  it("no charge happens while paused, even long after the old period end", async () => {
    const now = new Date();
    const active = await startActive(now);
    await pauseSubscription(orgId, 3, now);
    const charges = ssMocks.reloadOffSession.mock.calls.length;

    // Six weeks later: the old period end (~1 month) is long gone, the pause is not.
    const later = new Date(active.currentPeriodEnd.getTime() + 14 * DAY);
    await runSubscriptionSweep(later);
    const sub = await advanceSubscription((await getLiveSubscription(orgId))!, later);
    expect(sub.pausedAt).not.toBeNull();
    expect(sub.status).toBe("active");
    expect(ssMocks.reloadOffSession.mock.calls.length).toBe(charges);
  });

  it("sending stops while paused: affordability refuses, and is restored on unpause", async () => {
    const now = new Date();
    await startActive(now);
    await upsertCampaignAuthorizeCost(campaignId, orgId, "10.0000000000");
    const ok = await request(app).get(`/internal/campaigns/${campaignId}/affordability`).set(headers);
    expect(ok.body.affordable).toBe(true);

    await pauseSubscription(orgId, 1);
    expect(await isOrgSpendingPaused(orgId)).toBe(true);
    const refused = await request(app).get(`/internal/campaigns/${campaignId}/affordability`).set(headers);
    expect(refused.body.affordable).toBe(false);

    await unpauseSubscription(orgId);
    expect(await isOrgSpendingPaused(orgId)).toBe(false);
    const back = await request(app).get(`/internal/campaigns/${campaignId}/affordability`).set(headers);
    expect(back.body.affordable).toBe(true);
  });

  it("unpause: active again, period pushed by the paused time, next charge stated", async () => {
    const now = new Date();
    const active = await startActive(now);
    await pauseSubscription(orgId, 3, now);
    const resumeAt = new Date(now.getTime() + 10 * DAY);
    const sub = await unpauseSubscription(orgId, resumeAt);
    expect(sub.pausedAt).toBeNull();
    expect(sub.status).toBe("active");
    expect(sub.currentPeriodEnd.getTime()).toBe(active.currentPeriodEnd.getTime() + 10 * DAY);

    const read = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(read.body.subscription).toMatchObject({ status: "active", paused: false, can_pause: true });
    expect(read.body.subscription.next_charge_at).toBe(sub.currentPeriodEnd.toISOString());

    // The pushed renewal charges, and the next one is a month after it.
    const charges = ssMocks.reloadOffSession.mock.calls.length;
    const renewed = await advanceSubscription(sub, new Date(sub.currentPeriodEnd.getTime() + 1000));
    expect(ssMocks.reloadOffSession.mock.calls.length).toBe(charges + 1);
    expect(renewed.currentPeriodStart.toISOString()).toBe(sub.currentPeriodEnd.toISOString());
    expect(renewed.currentPeriodEnd.getUTCDate()).toBe(sub.currentPeriodEnd.getUTCDate());
  });

  it("the route unpauses; unpausing a plan that is not paused is refused", async () => {
    await startTrial();
    const not = await request(app).post("/v1/accounts/subscription/unpause").set(headers);
    expect(not.status).toBe(409);
    expect(not.body.code).toBe("subscription_not_paused");

    await request(app).post("/v1/accounts/subscription/pause").set(headers).send({ months: 1 });
    const res = await request(app).post("/v1/accounts/subscription/unpause").set(headers);
    expect(res.status).toBe(200);
    expect(res.body.subscription).toMatchObject({ status: "trialing", paused: false, pause_ends_at: null });
  });

  it("the pause ends on its own at pause_ends_at", async () => {
    const now = new Date();
    const active = await startActive(now);
    const paused = await pauseSubscription(orgId, 1, now);
    const after = new Date(paused.pauseEndsAt!.getTime() + 60 * 1000);
    await runSubscriptionSweep(after);
    const sub = (await getLiveSubscription(orgId))!;
    expect(sub.pausedAt).toBeNull();
    const pausedFor = paused.pauseEndsAt!.getTime() - now.getTime();
    expect(sub.currentPeriodEnd.getTime()).toBe(active.currentPeriodEnd.getTime() + pausedFor);
  });

  it("refusals: bad months, already paused, ended, cancel pending, amount change and start-now while paused", async () => {
    await startTrial();
    const bad = await request(app).post("/v1/accounts/subscription/pause").set(headers).send({ months: 4 });
    expect(bad.status).toBe(400);

    await request(app).post("/v1/accounts/subscription/pause").set(headers).send({ months: 1 });
    const again = await request(app).post("/v1/accounts/subscription/pause").set(headers).send({ months: 1 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("subscription_paused");

    const startNow = await request(app)
      .patch("/v1/accounts/subscription")
      .set(headers)
      .send({ monthly_amount_cents: 9900, start_now: true });
    expect(startNow.status).toBe(409);
    expect(startNow.body.code).toBe("subscription_paused");
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();

    await unpauseSubscription(orgId);
    await cancelSubscription(orgId);
    const pending = await request(app).post("/v1/accounts/subscription/pause").set(headers).send({ months: 1 });
    expect(pending.status).toBe(409);
    expect(pending.body.code).toBe("subscription_cancel_pending");

    const live = (await getLiveSubscription(orgId))!;
    await db
      .update(subscriptions)
      .set({ status: "canceled", endedAt: new Date() })
      .where(eq(subscriptions.id, live.id));
    const ended = await request(app).post("/v1/accounts/subscription/pause").set(headers).send({ months: 1 });
    expect(ended.status).toBe(409);
    expect(ended.body.code).toBe("subscription_ended");
    const endedPlan = await request(app)
      .post(`/v1/accounts/subscriptions/${live.id}/pause`)
      .set(headers)
      .send({ months: 1 });
    expect(endedPlan.status).toBe(409);
    expect(endedPlan.body.code).toBe("subscription_ended");
  });

  it("an active plan's amount cannot change while paused; the per-plan routes pause and unpause", async () => {
    const now = new Date();
    const active = await startActive(now);
    const paused = await request(app)
      .post(`/v1/accounts/subscriptions/${active.id}/pause`)
      .set(headers)
      .send({ months: 3 });
    expect(paused.status).toBe(200);
    expect(paused.body.subscription).toMatchObject({ id: active.id, paused: true, can_change_amount: false });

    const change = await request(app)
      .patch(`/v1/accounts/subscriptions/${active.id}`)
      .set(headers)
      .send({ monthly_amount_cents: 19900 });
    expect(change.status).toBe(409);
    expect(change.body.code).toBe("subscription_paused");

    const resumed = await request(app).post(`/v1/accounts/subscriptions/${active.id}/unpause`).set(headers);
    expect(resumed.status).toBe(200);
    expect(resumed.body.subscription).toMatchObject({ status: "active", paused: false });
  });

  it("revenue: a paused plan is not recurring", async () => {
    const now = new Date();
    await startActive(now);
    expect((await getOrgRevenue(orgId))!.revenueClass).toBe("recurring");
    await pauseSubscription(orgId, 1);
    const rev = (await getOrgRevenue(orgId))!;
    expect(rev.revenueClass).toBe("none");
    expect(rev.classReason).toBe("subscription_paused");
  });
});
