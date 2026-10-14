/**
 * Owner alerts stay silent when WE are behind the event (lib/staff-alert-guard),
 * decided on WHO acted and WHOSE org it is, never on the route.
 *
 * Replays prod 2026-10-14: a staff E2E switched "STAFF TEST - Email Sending E2E"
 * (only user kevin.lourd+e2eclient1014@gmail.com) to prepaid through the CUSTOMER
 * route with no x-email, and the owner got "Payment mode: postpaid → prepaid".
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import * as telegram from "../../src/lib/telegram-client.js";
import * as brandClient from "../../src/lib/brand-service-client.js";
import * as clientService from "../../src/lib/client-service-client.js";
import { deliver } from "../../src/lib/owner-alerts.js";
import { scanOrgPayments } from "../../src/lib/payment-alerts.js";
import { paymentModeAlertText } from "../../src/lib/payment-mode.js";

const orgId = "06ffd332-b05d-4468-bc33-fe2789cadd01";
const staffUserId = "d5299b91-f282-4882-8e76-1b2017cfdd02";
const clientUserId = "1c1e4b2a-7d3e-4f5a-9b6c-2d3e4f5add03";
const app = createTestApp();

describe("owner alerts: never a staff action, never a staff test org", () => {
  let ss: ReturnType<typeof setupStripeMocks>;
  let send: ReturnType<typeof vi.spyOn>;
  let users: ReturnType<typeof vi.spyOn>;
  const settle = () => new Promise((r) => setTimeout(r, 50));

  beforeEach(async () => {
    vi.restoreAllMocks();
    ss = setupStripeMocks();
    await cleanTestData();
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_OWNER_CHAT_ID = "42";
    send = vi.spyOn(telegram, "sendOwnerTelegram").mockResolvedValue({ ok: true, messageId: 1 });
    vi.spyOn(brandClient, "resolveOrgDisplayIdentity").mockResolvedValue({ name: "Reed", domain: "reed.co.uk" });
    users = vi.spyOn(clientService, "fetchOrgUsers").mockResolvedValue([]);

    ss.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@reed.test"));
    ss.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ss.hasChargeablePmForOrg.mockResolvedValue(false);
    ss.getOrgCardCountryByOrg.mockResolvedValue(null);
    const runs = await import("../../src/lib/runs-client.js");
    vi.spyOn(runs, "fetchRunsOrgUsageTotal").mockResolvedValue({ org_id: orgId, spent_cents: "0.0000000000", as_of: "x" } as never);
    vi.spyOn(runs, "fetchRunsOrgActualUsageTotal").mockResolvedValue({ spent_cents: "0.0000000000" } as never);
  });

  afterAll(async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_OWNER_CHAT_ID;
    await cleanTestData();
    await closeDb();
  });

  const switchToPrepaid = (userId: string) =>
    request(app).put("/v1/accounts/payment_mode").set(getAuthHeaders(orgId, userId)).send({ payment_mode: "prepaid" });

  it("this morning's replay: staff test org, customer route, no x-email -> NO alert", async () => {
    await insertTestAccount({ orgId });
    users.mockResolvedValue([{ id: staffUserId, email: "kevin.lourd+e2eclient1014@gmail.com" }]);
    expect((await switchToPrepaid(staffUserId)).status).toBe(200);
    await settle();
    expect(send).not.toHaveBeenCalled();
  });

  it("a real client switching on their own org -> alert in plain English", async () => {
    await insertTestAccount({ orgId });
    users.mockResolvedValue([{ id: clientUserId, email: "founder@reed.test" }]);
    expect((await switchToPrepaid(clientUserId)).status).toBe(200);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    const html = String(send.mock.calls[0][0]);
    expect(html).toContain("<b>Reed</b> (reed.co.uk)");
    expect(html).toContain("Now pays upfront (before: paid after use). Changed by the client.");
    expect(html).not.toMatch(/postpaid|prepaid|→|—|–/);
  });

  it("staff acting inside a real client's org (x-user-id is staff, no x-email) -> NO alert", async () => {
    await insertTestAccount({ orgId });
    users.mockResolvedValue([
      { id: clientUserId, email: "founder@reed.test" },
      { id: staffUserId, email: "kevin@distribute.you" },
    ]);
    expect((await switchToPrepaid(staffUserId)).status).toBe(200);
    await settle();
    expect(send).not.toHaveBeenCalled();
  });

  it("every sender: a sweep event (no actor) on a staff test org is silent; an org with no user still alerts", async () => {
    users.mockResolvedValue([{ id: staffUserId, email: "kevin.lourd+e2e@gmail.com" }]);
    expect(await deliver({ orgId, text: "Charge refused" }, null)).toBe("skipped");
    users.mockResolvedValue([]);
    expect(await deliver({ orgId, text: "Charge refused" }, null)).toBe("sent");
  });

  it("client-service unreadable -> alert anyway (a missed client alert is worse)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    users.mockRejectedValue(new Error("client-service 503"));
    expect(await deliver({ orgId, text: "Charge refused" }, { email: null, userId: clientUserId })).toBe("sent");
  });

  it("a payment on a staff test org is not alerted", async () => {
    await insertTestAccount({ orgId });
    users.mockResolvedValue([{ id: staffUserId, email: "kevin.lourd+e2eclient1014@gmail.com" }]);
    ss.listOrgPayments.mockResolvedValue([
      { id: "pi_t", acquirer: "stripe", amount: 10000, currency: "usd", status: "succeeded", created: Math.floor(Date.now() / 1000) - 120 },
    ]);
    const r = await scanOrgPayments(orgId);
    expect(r.sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("plain-English text for every mode, with the extras in words", () => {
    expect(paymentModeAlertText({ from: "prepaid", to: "postpaid", settledCents: "0", reloadTurnedOn: false })).toBe(
      "Now pays after use (before: paid upfront). Changed by the client."
    );
    expect(paymentModeAlertText({ from: "postpaid", to: "subscription", settledCents: "1234", reloadTurnedOn: false })).toBe(
      "Now pays a monthly plan (before: paid after use). Changed by the client.\nThe $12.34 they owed was charged first."
    );
    expect(paymentModeAlertText({ from: "postpaid", to: "prepaid", settledCents: "0", reloadTurnedOn: true })).toBe(
      "Now pays upfront (before: paid after use). Changed by the client.\nAutomatic reload is now on: their card is charged when the balance runs low."
    );
  });
});
