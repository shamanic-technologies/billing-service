/**
 * Owner Telegram per customer billing event (lib/owner-alerts): auto top-up on /
 * changed / off, subscription lifecycle, a refused charge once a day. Never the
 * owner's own actions, never a re-save, a failed send never fails the write.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import * as telegram from "../../src/lib/telegram-client.js";
import * as brandClient from "../../src/lib/brand-service-client.js";
import { deliver } from "../../src/lib/owner-alerts.js";
import {
  cancelSubscription,
  changeSubscriptionAmount,
  pauseSubscription,
  startSubscription,
  advanceSubscription,
} from "../../src/lib/subscription.js";

const orgId = "00000000-0000-0000-0000-0000000000b7";
const userId = "00000000-0000-0000-0000-0000000000b9";
const DAY = 24 * 60 * 60 * 1000;
const app = createTestApp();

describe("owner Telegram per customer billing event", () => {
  let ss: ReturnType<typeof setupStripeMocks>;
  let send: ReturnType<typeof vi.spyOn>;
  let paid = 0;

  const messages = () => send.mock.calls.map((c) => String(c[0]));
  const settle = () => new Promise((r) => setTimeout(r, 50));

  beforeEach(async () => {
    vi.restoreAllMocks();
    ss = setupStripeMocks();
    await cleanTestData();
    paid = 0;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_OWNER_CHAT_ID = "42";
    send = vi.spyOn(telegram, "sendOwnerTelegram").mockResolvedValue({ ok: true, messageId: 1 });
    vi.spyOn(brandClient, "resolveOrgDisplayIdentity").mockResolvedValue({ name: "Legistai", domain: "legistai.com" });

    ss.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@new.test"));
    ss.sumSucceededTopupsForOrg.mockImplementation(async () => `${paid}.0000000000`);
    ss.reloadOffSession.mockImplementation(async (_o: string, amount: number) => {
      paid += amount;
      return { status: "succeeded", reference: "pi_mock" };
    });
    ss.hasChargeablePmForOrg.mockResolvedValue(true);
    ss.getOrgCardCountryByOrg.mockResolvedValue("US");
    ss.getSavedPaymentMethod.mockResolvedValue({
      object: "saved_payment_method",
      org_id: orgId,
      acquirer: "revolut",
      saved: true,
      method: { id: "rpm_1", type: "card", saved_for: "merchant" },
    });
    ss.authorizeRecurringCharges.mockResolvedValue({ authorized: true, details: {} });
    const runs = await import("../../src/lib/runs-client.js");
    vi.spyOn(runs, "fetchRunsOrgUsageTotal").mockResolvedValue({ org_id: orgId, spent_cents: "0.0000000000", as_of: "x" } as never);
    vi.spyOn(runs, "fetchRunsOrgActualUsageTotal").mockResolvedValue({ spent_cents: "0.0000000000" } as never);
    vi.spyOn(runs, "createPlatformRun").mockResolvedValue("00000000-0000-0000-0000-00000000a001");
    vi.spyOn(runs, "completePlatformRun").mockResolvedValue(undefined);
    const email = await import("../../src/lib/email-client.js");
    vi.spyOn(email, "sendEmail").mockImplementation(vi.fn());
  });

  afterAll(async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_OWNER_CHAT_ID;
    await cleanTestData();
    await closeDb();
  });

  it("auto top-up: turned on, a re-save sends nothing, changed, turned off", async () => {
    await insertTestAccount({ orgId });
    const h = { ...getAuthHeaders(orgId, userId), "x-email": "client@acme.com" };

    expect((await request(app).patch("/v1/accounts/auto_topup").set(h).send({ topup_amount_cents: 10000, topup_threshold_cents: 500 })).status).toBe(200);
    await request(app).patch("/v1/accounts/auto_topup").set(h).send({ topup_amount_cents: 10000, topup_threshold_cents: 500 });
    await request(app).patch("/v1/accounts/auto_topup").set(h).send({ topup_amount_cents: 20000, topup_threshold_cents: 1000 });
    await request(app).delete("/v1/accounts/auto_topup").set(h);
    await settle();

    const m = messages();
    expect(m).toHaveLength(3);
    expect(m[0]).toContain("<b>Legistai</b> (legistai.com)");
    expect(m[0]).toContain("Automatic reload turned ON: $100.00 when the balance falls below $5.00");
    expect(m[1]).toContain("Automatic reload changed: $100.00 below $5.00 → $200.00 below $10.00");
    expect(m[2]).toContain("Automatic reload turned OFF");
  });

  it("never alerts the owner's own action (staff x-email)", async () => {
    await insertTestAccount({ orgId });
    const h = { ...getAuthHeaders(orgId, userId), "x-email": "kevin@distribute.you" };
    await request(app).patch("/v1/accounts/auto_topup").set(h).send({ topup_amount_cents: 10000, topup_threshold_cents: 500 });
    await settle();
    expect(send).not.toHaveBeenCalled();
  });

  it("a failed Telegram send never fails the billing write", async () => {
    await insertTestAccount({ orgId });
    send.mockResolvedValue({ ok: false, error: "telegram 502" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app)
      .patch("/v1/accounts/auto_topup")
      .set(getAuthHeaders(orgId, userId))
      .send({ topup_amount_cents: 10000, topup_threshold_cents: 500 });
    expect(res.status).toBe(200);
  });

  it("subscription: started (trial), upgraded, paused", async () => {
    await insertTestAccount({ orgId });
    const now = new Date();
    const trial = await startSubscription({ orgId, userId, monthlyAmountCents: 9900, now: new Date(now.getTime() - 4 * DAY) });
    await advanceSubscription(trial, now); // trial end paid: a payment, not a lifecycle message
    await changeSubscriptionAmount(orgId, 19900, now);
    await pauseSubscription(orgId, 2, now);
    await settle();

    const m = messages();
    expect(m).toHaveLength(3);
    expect(m[0]).toContain("Subscription started: $99.00/month, 3-day free trial");
    expect(m[1]).toContain("Subscription upgraded: $99.00 → $199.00/month");
    expect(m[2]).toContain("Subscription paused for 2 months");
  });

  it("cancelling an active plan tells the owner when it ends", async () => {
    await insertTestAccount({ orgId });
    const now = new Date();
    const trial = await startSubscription({ orgId, userId, monthlyAmountCents: 9900, now: new Date(now.getTime() - 4 * DAY) });
    await advanceSubscription(trial, now);
    await cancelSubscription(orgId, now);
    await settle();
    expect(messages().some((m) => m.includes("Subscription cancelled ($99.00/month): ends "))).toBe(true);
  });

  it("an event with a dedup key is sent once (a refused charge, once per org per day)", async () => {
    await insertTestAccount({ orgId });
    const event = { orgId, text: "Charge refused: $50.00 (Automatic reload)", dedupKey: `charge-refused:${orgId}:2026-10-06` };
    expect(await deliver(event, null)).toBe("sent");
    expect(await deliver(event, null)).toBe("skipped");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a failed send releases the dedup claim so the event is not lost", async () => {
    await insertTestAccount({ orgId });
    vi.spyOn(console, "error").mockImplementation(() => {});
    send.mockResolvedValueOnce({ ok: false, error: "telegram 502" });
    const event = { orgId, text: "Subscription ended ($99.00/month)", dedupKey: "sub-ended:x" };
    expect(await deliver(event, null)).toBe("failed");
    expect(await deliver(event, null)).toBe("sent");
  });
});
