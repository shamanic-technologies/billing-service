/**
 * Owner Telegram alert per succeeded payment (lib/payment-alerts).
 *
 * Pins: one message per payment that SUCCEEDED, never for a pending/abandoned
 * checkout; exactly once across re-scans; the owner's own payments are never
 * alerted; a failed send is retried, never lost and never doubled.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { cleanTestData, insertTestAccount, closeDb, SEEDED_PLATFORM_ORG_ID } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { paymentAlerts, paymentAlertSignals } from "../../src/db/schema.js";
import * as telegram from "../../src/lib/telegram-client.js";
import * as brandClient from "../../src/lib/brand-service-client.js";
import {
  runPaymentAlertScan,
  scanOrgPayments,
  recordChargeSignal,
  recordCheckoutOpened,
  isStaffEmail,
} from "../../src/lib/payment-alerts.js";

const orgId = "00000000-0000-0000-0000-0000000000a7";
const NOW = new Date();
const sec = (msAgo: number) => Math.floor((NOW.getTime() - msAgo) / 1000);

function payment(over: Partial<{ id: string; acquirer: string; amount: number; currency: string; status: string; created: number }> = {}) {
  return {
    id: "pi_1",
    acquirer: "stripe",
    amount: 10000,
    currency: "usd",
    status: "succeeded",
    created: sec(2 * 60 * 1000),
    ...over,
  };
}

describe("owner Telegram alert when a customer pays", () => {
  let ss: ReturnType<typeof setupStripeMocks>;
  let send: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ss = setupStripeMocks();
    await cleanTestData();
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_OWNER_CHAT_ID = "42";
    send = vi.spyOn(telegram, "sendOwnerTelegram").mockResolvedValue({ ok: true, messageId: 1 });
    vi.spyOn(brandClient, "resolveOrgDisplayIdentity").mockResolvedValue({ name: "Legistai", domain: "legistai.com" });
  });

  afterAll(async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_OWNER_CHAT_ID;
    await cleanTestData();
    await closeDb();
  });

  it("a succeeded checkout payment sends ONE message with org, amount, kind, first-ever, acquirer", async () => {
    await insertTestAccount({ orgId });
    ss.listOrgPayments.mockResolvedValue([payment({ id: "ord_1", acquirer: "revolut" })]);

    const r = await runPaymentAlertScan({ full: true, now: NOW });

    expect(r.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    const html = send.mock.calls[0][0] as string;
    expect(html).toContain("$100.00 paid");
    expect(html).toContain("<b>Legistai</b> (legistai.com)");
    expect(html).toContain("Top-up at checkout · Revolut");
    expect(html).toContain("First payment ever");
    const [row] = await db.select().from(paymentAlerts).where(eq(paymentAlerts.paymentKey, "revolut:ord_1"));
    expect(row.outcome).toBe("sent");
  });

  it("re-scanning the same payment never sends a second message", async () => {
    await insertTestAccount({ orgId });
    ss.listOrgPayments.mockResolvedValue([payment()]);

    await runPaymentAlertScan({ full: true, now: NOW });
    await runPaymentAlertScan({ full: true, now: NOW });
    await scanOrgPayments(orgId, NOW);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a pending (abandoned) checkout and a failed charge send nothing and claim nothing", async () => {
    await insertTestAccount({ orgId });
    await recordCheckoutOpened(orgId, "client@acme.com", 10000);
    ss.listOrgPayments.mockResolvedValue([
      payment({ id: "ord_pending", acquirer: "revolut", status: "pending" }),
      payment({ id: "pi_failed", status: "failed" }),
    ]);

    const r = await runPaymentAlertScan({ full: false, now: NOW });

    expect(r.orgs).toBe(1); // the opened checkout made it a hot org
    expect(send).not.toHaveBeenCalled();
    expect(await db.select().from(paymentAlerts)).toHaveLength(0);
  });

  it("labels an off-session charge by its reason and counts the org's payments", async () => {
    await insertTestAccount({ orgId });
    // Stripe answers the charge with an invoice id, not the PaymentIntent id: matched on amount + time.
    await recordChargeSignal(orgId, "in_123", undefined, 5000);
    ss.listOrgPayments.mockResolvedValue([
      payment({ id: "pi_old", created: sec(10 * 24 * 3600 * 1000) }), // before: payment #1, never re-alerted
      payment({ id: "pi_reload", amount: 5000 }),
    ]);

    await scanOrgPayments(orgId, NOW);

    expect(send).toHaveBeenCalledTimes(1);
    const html = send.mock.calls[0][0] as string;
    expect(html).toContain("$50.00 paid");
    expect(html).toContain("Automatic reload · Stripe");
    expect(html).toContain("Payment #2 from this org");
  });

  it("a subscription charge on Revolut is matched by its reference", async () => {
    await insertTestAccount({ orgId });
    await recordChargeSignal(orgId, "ord_sub", "subscription", 9900);
    ss.listOrgPayments.mockResolvedValue([payment({ id: "ord_sub", acquirer: "revolut", amount: 9900 })]);

    await scanOrgPayments(orgId, NOW);

    expect(send.mock.calls[0][0]).toContain("Subscription charge · Revolut");
  });

  it("never alerts the owner's own actions: staff checkout, hand-recorded money, platform org", async () => {
    await insertTestAccount({ orgId });
    await recordCheckoutOpened(orgId, "Kevin@Distribute.you", 10000);
    ss.listOrgPayments.mockResolvedValue([
      payment({ id: "pi_staff" }),
      payment({ id: "dp_1", acquirer: "direct" }),
    ]);
    await scanOrgPayments(orgId, NOW);

    ss.listOrgPayments.mockResolvedValue([payment({ id: "pi_platform" })]);
    await scanOrgPayments(SEEDED_PLATFORM_ORG_ID, NOW);

    expect(send).not.toHaveBeenCalled();
    const rows = await db.select().from(paymentAlerts);
    expect(rows.map((r) => [r.paymentKey, r.skipReason]).sort()).toEqual([
      ["stripe:pi_platform", "platform_org"],
      ["stripe:pi_staff", "staff_actor"],
    ]);
    expect(isStaffEmail("kevin.lourd+qa@gmail.com")).toBe(true);
    expect(isStaffEmail("client@acme.com")).toBe(false);
  });

  it("a failed Telegram send releases the claim, the next scan sends it once", async () => {
    await insertTestAccount({ orgId });
    ss.listOrgPayments.mockResolvedValue([payment()]);
    send.mockResolvedValueOnce({ ok: false, error: "telegram 502" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const first = await scanOrgPayments(orgId, NOW);
    expect(first.failed).toBe(1);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("Telegram send FAILED"))).toBe(true);
    expect(await db.select().from(paymentAlerts)).toHaveLength(0);

    const second = await scanOrgPayments(orgId, NOW);
    expect(second.sent).toBe(1);
    await scanOrgPayments(orgId, NOW);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not alert a payment inside the grace window or older than three days", async () => {
    await insertTestAccount({ orgId });
    ss.listOrgPayments.mockResolvedValue([
      payment({ id: "pi_just_now", created: sec(5 * 1000) }),
      payment({ id: "pi_ancient", created: sec(4 * 24 * 3600 * 1000) }),
    ]);

    await scanOrgPayments(orgId, NOW);

    expect(send).not.toHaveBeenCalled();
  });

  it("with Telegram unconfigured, nothing is claimed (alerted once it is fixed)", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await insertTestAccount({ orgId });
    ss.listOrgPayments.mockResolvedValue([payment()]);

    const r = await runPaymentAlertScan({ full: true, now: NOW });

    expect(r.unconfigured).toBe(true);
    expect(await db.select().from(paymentAlerts)).toHaveLength(0);
    expect(await db.select().from(paymentAlertSignals)).toHaveLength(0);
  });
});
