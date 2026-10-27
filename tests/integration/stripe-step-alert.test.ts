/**
 * ONE owner Telegram per card step, carrying what the card page showed, every
 * campaign budget set right after, and the monthly charge limit
 * (lib/stripe-step-alert, OWNER-PING-BUDGET-1027).
 *
 * Replays Beyond Logic 2026-10-27: limit $9,000 set 17:42:48, card saved to pay
 * after use 17:44:11, two $10/month funnel caps written 17:44:13 and 17:44:28.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import * as telegram from "../../src/lib/telegram-client.js";
import * as brandClient from "../../src/lib/brand-service-client.js";
import * as catalogue from "../../src/lib/sales-funnel-catalogue.js";
import type { SalesFunnel } from "../../src/lib/sales-funnel-catalogue.js";
import {
  composeStripeStepText,
  runStripeStepAlertSweep,
  STRIPE_STEP_SETTLE_MS,
} from "../../src/lib/stripe-step-alert.js";
import { db } from "../../src/db/index.js";
import { setMonthlyChargeLimit } from "../../src/lib/monthly-charge-limit.js";
import { ownerStripeStepAlerts } from "../../src/db/schema.js";

const orgId = "8c043fa7-88b9-4e92-a96b-3dab875cb465";
const userId = "00000000-0000-0000-0000-0000000000c9";
const brandId = "00000000-0000-0000-0000-0000000000d1";
const offerId = "00000000-0000-0000-0000-0000000000d2";
const COLD =
  "start_to_lead_found@lead-sourcing~valid-catch-all+lead_found_to_conversation@sales-cold-email-outreach~no-offer-emails+conversation_to_paid_client";
const BOOKING = "conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";

const FUNNELS: Record<string, SalesFunnel> = {
  [COLD]: {
    id: COLD,
    name: "Wide Email Replies 23",
    type: "proactive",
    triggerSlug: null,
    triggerName: null,
    pipes: [
      { pipeId: "lead-sourcing|start_to_lead_found~valid-catch-all", channelSlug: "lead-sourcing", legKey: "start_to_lead_found", strategyId: "valid-catch-all", mode: "proactive", toStep: "lead_found" },
      { pipeId: "sales-cold-email-outreach|lead_found_to_conversation~no-offer-emails", channelSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", strategyId: "no-offer-emails", mode: "proactive", toStep: "email_sent" },
    ],
  },
  [BOOKING]: {
    id: BOOKING,
    name: "Reply Booking",
    type: "reactive",
    triggerSlug: "positive_reply_received",
    triggerName: "Positive reply",
    pipes: [
      { pipeId: "ai-meeting-booking|conversation_to_meeting_booked", channelSlug: "ai-meeting-booking", legKey: "conversation_to_meeting_booked", strategyId: null, mode: "reactive", toStep: "meeting_booked" },
    ],
  },
};

const app = createTestApp();
const at = (hms: string) => new Date(`2026-10-27T${hms}.000Z`);

describe("owner ping for the card step carries budgets, limit and what the card page showed", () => {
  let ss: ReturnType<typeof setupStripeMocks>;
  let send: ReturnType<typeof vi.spyOn>;
  const messages = () => send.mock.calls.map((c) => String(c[0]));
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const client = { ...getAuthHeaders(orgId, userId), "x-email": "founder@beyondlogic.test" };

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    ss = setupStripeMocks();
    await cleanTestData();
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_OWNER_CHAT_ID = "42";
    send = vi.spyOn(telegram, "sendOwnerTelegram").mockResolvedValue({ ok: true, messageId: 1 });
    vi.spyOn(brandClient, "resolveOrgDisplayIdentity").mockResolvedValue({ name: "Beyond Logic", domain: "beyondlogic.test" });
    vi.spyOn(catalogue, "getSalesFunnel").mockImplementation(async (id: string) => {
      const f = FUNNELS[id];
      if (!f) throw new catalogue.SalesFunnelNotFoundError(id);
      return f;
    });
    ss.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@beyondlogic.test"));
    ss.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ss.hasChargeablePmForOrg.mockResolvedValue(true);
    ss.getOrgCardCountryByOrg.mockResolvedValue("US");
    ss.getSavedPaymentMethod.mockResolvedValue({
      object: "saved_payment_method",
      org_id: orgId,
      acquirer: "revolut",
      saved: true,
      method: { id: "rpm_1", type: "card", saved_for: "merchant", funding: "debit", prepaid: false },
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

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_OWNER_CHAT_ID;
    await cleanTestData();
    await closeDb();
  });

  const putCap = (funnel: string) =>
    request(app)
      .put(`/v1/brands/${brandId}/offers/${offerId}/sales-funnels/${encodeURIComponent(funnel)}/caps`)
      .set(client)
      .send({ maxBudget: { amountCents: 1000, period: "monthly" }, maxVolume: null });

  it("Beyond Logic replay: one ping after the caps landed, with $0, both budgets, total and limit", async () => {
    await insertTestAccount({ orgId, paymentMode: "postpaid", postpaidCardCheck: "passed" });

    vi.setSystemTime(at("17:42:48"));
    // The limit route's own 🧱 line is unchanged (owner-billing-alerts); its write is what counts here.
    await setMonthlyChargeLimit(orgId, 900000, userId);

    vi.setSystemTime(at("17:44:11"));
    const mode = await request(app).put("/v1/accounts/payment_mode").set(client).send({ payment_mode: "postpaid" });
    expect(mode.status).toBe(200);
    await settle();
    expect(messages()).toHaveLength(0); // nothing at the card step itself

    vi.setSystemTime(at("17:44:13"));
    expect((await putCap(COLD)).status).toBe(200);
    vi.setSystemTime(at("17:44:20"));
    expect(await runStripeStepAlertSweep(new Date())).toEqual({ sent: 0, skipped: 0, failed: 0 });
    vi.setSystemTime(at("17:44:28"));
    expect((await putCap(BOOKING)).status).toBe(200);
    vi.setSystemTime(at("17:45:05"));
    expect(await runStripeStepAlertSweep(new Date())).toEqual({ sent: 0, skipped: 0, failed: 0 });

    vi.setSystemTime(at("17:45:12"));
    expect(await runStripeStepAlertSweep(new Date())).toEqual({ sent: 1, skipped: 0, failed: 0 });
    const ping = messages()[0];
    expect(ping).toContain("💳 <b>Beyond Logic</b>");
    expect(ping).toContain("Card page: $0 today, card saved.");
    expect(ping).toContain("Pays after use: first charge when spend reaches $50.");
    expect(ping).toContain("• Wide Email Replies 23: $10/month");
    expect(ping).toContain("• Reply Booking, on each positive reply: $10/month");
    expect(ping.match(/\$10\/month/g)).toHaveLength(2);
    expect(ping).toContain("Total: $20/month");
    expect(ping).toContain("Monthly charge limit: $9,000");
    expect(ping).not.toMatch(/[—–]/);
    expect(ping).not.toMatch(/prepaid|postpaid/i);

    // Once only: a later sweep and a later cap change send nothing more from here.
    vi.setSystemTime(at("17:50:00"));
    expect((await putCap(COLD)).status).toBe(200);
    expect(await runStripeStepAlertSweep(new Date())).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(messages()).toHaveLength(1);
  });

  it("a cap landing just before the send pushes it back; never later than 10 minutes after the card step", async () => {
    await insertTestAccount({ orgId, paymentMode: "postpaid", postpaidCardCheck: "passed" });
    vi.setSystemTime(at("10:00:00"));
    await request(app).put("/v1/accounts/payment_mode").set(client).send({ payment_mode: "postpaid" });
    await settle();
    vi.setSystemTime(at("10:00:55"));
    await putCap(COLD);
    const [row] = await db.select().from(ownerStripeStepAlerts);
    expect(row.dueAt.toISOString()).toBe(at("10:01:15").toISOString());
    expect(await runStripeStepAlertSweep(at("10:01:05"))).toEqual({ sent: 0, skipped: 0, failed: 0 });

    vi.setSystemTime(at("10:09:55"));
    await putCap(BOOKING);
    const [capped] = await db.select().from(ownerStripeStepAlerts);
    // Pushed to 10:10:15 at most, held to 10 minutes after the card step.
    expect(capped.dueAt.toISOString()).toBe(at("10:10:00").toISOString());
    expect(await runStripeStepAlertSweep(at("10:10:00"))).toEqual({ sent: 1, skipped: 0, failed: 0 });
  });

  it("a staff actor at the card step: no ping", async () => {
    await insertTestAccount({ orgId, paymentMode: "postpaid", postpaidCardCheck: "passed" });
    vi.setSystemTime(at("11:00:00"));
    await request(app)
      .put("/v1/accounts/payment_mode")
      .set({ ...client, "x-email": "kevin@distribute.you" })
      .send({ payment_mode: "postpaid" });
    await settle();
    const r = await runStripeStepAlertSweep(new Date(at("11:00:00").getTime() + STRIPE_STEP_SETTLE_MS));
    expect(r.sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("first top-up checkout: the ping carries the amount the card page asked", async () => {
    await insertTestAccount({ orgId, paymentMode: "prepaid" });
    ss.createCheckoutSession.mockResolvedValue({ url: "https://checkout.stripe.com/pay/cs_1", session_id: "cs_1" });
    vi.setSystemTime(at("12:00:00"));
    const res = await request(app)
      .post("/v1/checkout-sessions")
      .set(client)
      .send({ success_url: "https://example.com/s", cancel_url: "https://example.com/c", topup_amount_cents: 10000 });
    expect(res.status).toBe(200);
    await settle();
    expect(await runStripeStepAlertSweep(at("12:01:30"))).toEqual({ sent: 0, skipped: 0, failed: 0 });
    vi.setSystemTime(at("12:01:40"));
    await putCap(COLD);
    expect(await runStripeStepAlertSweep(at("12:03:01"))).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(messages()[0]).toContain("Card page: $100.00 to pay now.");
    expect(messages()[0]).toContain("• Wide Email Replies 23: $10/month");
    expect(messages()[0]).toContain("Monthly charge limit: none");
  });

  it("a top-up by a client who already paid: no card-step ping (the payment alert tells it)", async () => {
    await insertTestAccount({ orgId, paymentMode: "prepaid" });
    ss.sumSucceededTopupsForOrg.mockResolvedValue("10000.0000000000");
    ss.createCheckoutSession.mockResolvedValue({ url: "https://checkout.stripe.com/pay/cs_2", session_id: "cs_2" });
    await request(app)
      .post("/v1/checkout-sessions")
      .set(client)
      .send({ success_url: "https://example.com/s", cancel_url: "https://example.com/c", topup_amount_cents: 10000 });
    await settle();
    expect(await db.select().from(ownerStripeStepAlerts)).toHaveLength(0);
  });

  it("composes mixed periods and volume caps in plain words", () => {
    const text = composeStripeStepText({
      stripeLine: "Card page: $99.00 paid now, then $99.00/month.",
      acceptedLine: null,
      budgets: [
        { funnelName: "A", triggerName: null, amountCents: "1050", period: "monthly", volume: null },
        { funnelName: "B", triggerName: null, amountCents: "500", period: "daily", volume: { count: 100, period: "monthly", unit: "first_contacts" } },
        { funnelName: "C", triggerName: null, amountCents: null, period: null, volume: { count: 20, period: "weekly", unit: null } },
      ],
      monthlyLimitCents: null,
    });
    expect(text).toBe(
      [
        "Card page: $99.00 paid now, then $99.00/month.",
        "Campaign budgets:",
        "• A: $10.50/month",
        "• B: $5/day, up to 100 first contacts/month",
        "• C: up to 20/week",
        "Total: $10.50/month + $5/day",
        "Monthly charge limit: none",
      ].join("\n")
    );
  });
});
