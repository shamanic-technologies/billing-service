/**
 * MONTHLY LIMIT = a SPEND cap (owner 2026-10-21, lib/monthly-charge-limit):
 * « LE BILLING EST LE BILLING!! ON PREND TOUT CE QU'IL Y A À PRENDRE [...] LE $30
 * C'EST BILLING SERVICE QUI DOIT BLOQUER LES RUNS ».
 *
 * Pins:
 *  - a charge is NEVER refused by the limit (the real `reloadOffSession`);
 *  - authorize refuses a campaign spend that would take this month's campaign
 *    spend past the limit (LBVisible: limit $30, spent $29.90, a $0.20 run is
 *    refused, a $0.05 one goes), ONE email, no reload attempted;
 *  - spends granted between two measurements are counted;
 *  - no campaign = the platform's cost, never counted, never refused;
 *  - raising the limit re-opens the month; the read serves the spend.
 *
 * Own file (one describe per file — see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import * as ssClient from "../../src/lib/stripe-service-client.js";
import * as runsClient from "../../src/lib/runs-client.js";
import * as runsOrgRead from "../../src/lib/runs-org-read.js";
import * as emailClient from "../../src/lib/email-client.js";
import * as budgetContext from "../../src/lib/budget-change-context.js";
import * as plans from "../../src/lib/subscription-plans.js";
import * as reload from "../../src/lib/reload.js";
import { _resetCoalescer } from "../../src/lib/reload-coalescer.js";
import {
  MONTHLY_CHARGE_LIMIT_REACHED_EVENT,
  _resetMonthlySpendCache,
  calendarMonthUtc,
  chargedThisMonthCents,
  composeMonthlyChargeLimitEmail,
  setMonthlyChargeLimit,
  spentThisMonthCents,
} from "../../src/lib/monthly-charge-limit.js";

const app = createTestApp();
const orgId = "00000000-0000-0000-0000-0000000000c7";
const PATH = "/v1/accounts/monthly_charge_limit";
const INTERNAL = `/internal/accounts/by-org/${orgId}/monthly-charge-limit`;

const nowUnix = () => Math.floor(Date.now() / 1000);
const payment = (amount: number, over: Partial<ssClient.OrgPayment> = {}): ssClient.OrgPayment => ({
  id: `pay_${Math.random().toString(36).slice(2)}`,
  acquirer: "stripe",
  amount,
  currency: "usd",
  status: "succeeded",
  created: nowUnix() - 60,
  ...over,
});

const campaignId = "00000000-0000-0000-0000-0000000000cc";

describe("monthly limit: a spend cap, never a charge refusal", () => {
  let payments: ssClient.OrgPayment[];
  let charge: ReturnType<typeof vi.fn>;
  let listPayments: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.fn>;
  let readSpend: ReturnType<typeof vi.fn>;
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let spent = "0.0000000000";
  let required = "10.0000000000";

  const authorize = () =>
    request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId), "x-campaign-id": campaignId })
      .send({ items: [{ costName: "x", quantity: 1 }] });

  beforeEach(async () => {
    vi.restoreAllMocks();
    _resetCoalescer();
    _resetMonthlySpendCache();
    await cleanTestData();
    spent = "0.0000000000";
    required = "10.0000000000";
    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("owner@client.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("LT");
    readSpend = vi.fn(async () => ({ groups: [{ dimensions: { campaignId }, netTotalCostInUsdCents: spent }] }));
    vi.spyOn(runsOrgRead, "readJson").mockImplementation(readSpend as never);
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: spent,
      as_of: "2026-10-21T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: spent,
      as_of: "2026-10-21T00:00:00.000Z",
    }));
    const costs = await import("../../src/lib/costs-client.js");
    vi.spyOn(costs, "resolveRequiredCents").mockImplementation(async () => required);
    payments = [];
    listPayments = vi.fn(async () => payments);
    vi.spyOn(ssClient, "listOrgPayments").mockImplementation(listPayments as never);
    charge = vi.fn(async (_org: string, body: { amount: number }) => {
      payments.push(payment(body.amount));
      return { status: "succeeded", reference: `ch_${payments.length}` } as never;
    });
    vi.spyOn(ssClient, "chargeOrgOffSession").mockImplementation(charge as never);
    vi.spyOn(ssClient, "fetchOrgCustomerOrNull").mockResolvedValue({ id: "cus_1", email: "owner@client.test" } as never);
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue("11111111-1111-1111-1111-111111111111");
    vi.spyOn(runsClient, "completePlatformRun").mockResolvedValue();
    vi.spyOn(budgetContext, "fetchOrgIdentity").mockResolvedValue({ externalId: "org_clerk1" } as never);
    vi.spyOn(plans, "fetchOrgBrandIdsOldestFirst").mockResolvedValue(["b1"]);
    send = vi.fn();
    vi.spyOn(emailClient, "sendEmail").mockImplementation(send as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    // The limit email is fire-and-forget: let it settle before the DB closes.
    await new Promise((r) => setTimeout(r, 300));
    await cleanTestData();
    await closeDb();
  });

  it("a charge is never refused by the limit, even past it", async () => {
    await setMonthlyChargeLimit(orgId, 3000, null);
    payments.push(payment(29900));
    vi.mocked(reload.reloadOffSession).mockRestore();
    const out = await reload.reloadOffSession(orgId, 5000, "k-past");
    expect(out.status).toBe("succeeded");
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it("LBVisible: limit $30, spent $29.90, a $0.20 run is refused (no reload, one email), a $0.05 run goes", async () => {
    await insertTestAccount({ orgId, paymentMode: "postpaid", topupAmountCents: 5000, topupThresholdCents: 0 });
    await setMonthlyChargeLimit(orgId, 3000, null);
    spent = "2990.0000000000";
    required = "20.0000000000";
    const refused = await authorize();
    expect(refused.status).toBe(200);
    expect(refused.body.sufficient).toBe(false);
    expect(refused.body.reason).toBeUndefined();
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const mail = send.mock.calls[0][0];
    expect(mail.eventType).toBe(MONTHLY_CHARGE_LIMIT_REACHED_EVENT);
    expect(mail.metadata.bodyText).toContain("Your monthly limit is $30.00. Your campaigns spent $29.90 this month.");
    expect(mail.metadata.bodyText).not.toMatch(/[—–]/);

    // A second refusal: no second email.
    expect((await authorize()).body.sufficient).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(send).toHaveBeenCalledTimes(1);

    required = "5.0000000000";
    expect((await authorize()).body.sufficient).toBe(true);

    const read = await request(app).get(PATH).set(getAuthHeaders(orgId));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      monthly_charge_limit_cents: 3000,
      spent_this_period_cents: "2990.0000000000",
      remaining_cents: 10,
      limit_reached: true,
      refused_amount_cents: 20,
    });
  });

  it("spends granted between two measurements count toward the month", async () => {
    await insertTestAccount({ orgId, paymentMode: "postpaid", topupAmountCents: 5000, topupThresholdCents: 0 });
    await setMonthlyChargeLimit(orgId, 3000, null);
    spent = "2900.0000000000";
    required = "40.0000000000";
    expect((await authorize()).body.sufficient).toBe(true); // 2940
    expect((await authorize()).body.sufficient).toBe(true); // 2980
    expect((await authorize()).body.sufficient).toBe(false); // 3020 > 3000
    expect(readSpend).toHaveBeenCalledTimes(1);
  });

  it("no campaign: the platform's cost, never refused by the limit", async () => {
    await insertTestAccount({ orgId, paymentMode: "postpaid" });
    await setMonthlyChargeLimit(orgId, 0, null);
    spent = "100.0000000000";
    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(orgId))
      .send({ items: [{ costName: "x", quantity: 1 }] });
    expect(res.body.sufficient).toBe(true);
  });

  it("raising the limit re-opens the month", async () => {
    await insertTestAccount({ orgId, paymentMode: "postpaid", topupAmountCents: 5000, topupThresholdCents: 0 });
    await setMonthlyChargeLimit(orgId, 3000, null);
    spent = "3000.0000000000";
    expect((await authorize()).body.sufficient).toBe(false);
    const put = await request(app).put(PATH).set(getAuthHeaders(orgId)).send({ monthly_charge_limit_cents: 6000 });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ monthly_charge_limit_cents: 6000, limit_reached: false, remaining_cents: 3000 });
    _resetMonthlySpendCache();
    expect((await authorize()).body.sufficient).toBe(true);
  });

  it("the month's spend counts campaign groups only, from the 1st (UTC)", async () => {
    readSpend.mockResolvedValueOnce({
      groups: [
        { dimensions: { campaignId: "c1" }, netTotalCostInUsdCents: "100.5" },
        { dimensions: { campaignId: null }, netTotalCostInUsdCents: "999" },
        { dimensions: { campaignId: "c2" }, netTotalCostInUsdCents: "0.5" },
      ],
    });
    expect(await spentThisMonthCents(orgId)).toBe("101.0000000000");
    const params = readSpend.mock.calls[0][2] as URLSearchParams;
    expect(params.get("groupBy")).toBe("campaignId");
    expect(params.get("startedAfter")).toBe(calendarMonthUtc(new Date()).start.toISOString());
  });

  it("card charges this month (information only): succeeded + pending of this UTC month", async () => {
    const { start } = calendarMonthUtc(new Date());
    const startUnix = Math.floor(start.getTime() / 1000);
    payments.push(
      payment(1000),
      payment(2000, { status: "pending" }),
      payment(4000, { status: "failed" }),
      payment(8000, { acquirer: "direct" }),
      payment(16000, { created: startUnix - 10 }),
      payment(32000, { created: startUnix, acquirer: "revolut" })
    );
    expect(await chargedThisMonthCents(orgId)).toBe(1000 + 2000 + 32000);
  });

  it("routes: read without a limit, validate, set, clear", async () => {
    const empty = await request(app).get(PATH).set(getAuthHeaders(orgId));
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({
      monthly_charge_limit_cents: null,
      charged_this_period_cents: null,
      spent_this_period_cents: null,
      remaining_cents: null,
      limit_reached: false,
    });
    expect(listPayments).not.toHaveBeenCalled();
    expect(readSpend).not.toHaveBeenCalled();

    for (const bad of [{ monthly_charge_limit_cents: -1 }, { monthly_charge_limit_cents: 10.5 }, {}]) {
      const r = await request(app).put(PATH).set(getAuthHeaders(orgId)).send(bad);
      expect(r.status).toBe(400);
    }

    const internal = await request(app).put(INTERNAL).set(getAuthHeaders(orgId)).send({ monthly_charge_limit_cents: 29900 });
    expect(internal.status).toBe(200);
    expect(internal.body.monthly_charge_limit_cents).toBe(29900);

    const del = await request(app).delete(PATH).set(getAuthHeaders(orgId));
    expect(del.status).toBe(200);
    expect(del.body.monthly_charge_limit_cents).toBeNull();
    const again = await request(app).delete(INTERNAL).set(getAuthHeaders(orgId));
    expect(again.status).toBe(200);
  });

  it("the email is short, plain and has one button", () => {
    const email = composeMonthlyChargeLimitEmail({
      limitCents: 3000,
      chargedCents: 2990,
      refusedAmountCents: 20,
      resetsAt: new Date("2026-11-01T00:00:00Z"),
      ctaUrl: "https://dashboard.distribute.you/x",
    });
    expect(email.subject).toBe("You reached your monthly limit");
    expect(email.bodyText).toContain("Your campaigns start again on November 1, or right away if you raise your limit.");
    expect(email.bodyText).not.toContain("charge");
    expect(email.bodyHtml.match(/<a /g)?.length).toBe(1);
    expect(email.bodyHtml).not.toMatch(/[—–]/);
  });
});
