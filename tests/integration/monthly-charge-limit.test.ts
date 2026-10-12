/**
 * MONTHLY CHARGE LIMIT (owner 2026-10-12, lib/monthly-charge-limit).
 *
 * Pins, against the REAL `reloadOffSession` (only the acquirer call is mocked):
 *  - no limit = no change: the charge goes out, the payments list is never read;
 *  - the worked example: $99 + $100 + $100 charged, limit $299, the next $100 is
 *    NOT sent to any acquirer, the outcome says `limitReached`, ONE email;
 *  - a second refusal the same month sends no second email;
 *  - raising the limit re-opens the month: the next charge goes out;
 *  - what counts: succeeded + pending card payments of THIS UTC month, never
 *    `direct`, never failed, never last month;
 *  - the routes read / set / clear it and validate the body.
 *
 * Own file (one describe per file — see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import * as ssClient from "../../src/lib/stripe-service-client.js";
import * as runsClient from "../../src/lib/runs-client.js";
import * as emailClient from "../../src/lib/email-client.js";
import * as budgetContext from "../../src/lib/budget-change-context.js";
import * as plans from "../../src/lib/subscription-plans.js";
import { reloadOffSession } from "../../src/lib/reload.js";
import {
  MONTHLY_CHARGE_LIMIT_REACHED_EVENT,
  calendarMonthUtc,
  chargedThisMonthCents,
  composeMonthlyChargeLimitEmail,
  setMonthlyChargeLimit,
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

describe("monthly charge limit", () => {
  let payments: ssClient.OrgPayment[];
  let charge: ReturnType<typeof vi.fn>;
  let listPayments: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
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

  it("no limit: the charge goes out and the payments list is never read", async () => {
    const out = await reloadOffSession(orgId, 10000, "k-nolimit");
    expect(out.status).toBe("succeeded");
    expect(out.limitReached).toBeUndefined();
    expect(charge).toHaveBeenCalledTimes(1);
    expect(listPayments).not.toHaveBeenCalled();
  });

  it("worked example: $99 + $100 + $100 under a $299 limit, the next $100 is refused, one email", async () => {
    await setMonthlyChargeLimit(orgId, 29900, null);
    expect((await reloadOffSession(orgId, 9900, "k1")).status).toBe("succeeded");
    expect((await reloadOffSession(orgId, 10000, "k2")).status).toBe("succeeded");
    expect((await reloadOffSession(orgId, 10000, "k3")).status).toBe("succeeded");
    expect(charge).toHaveBeenCalledTimes(3);

    const refused = await reloadOffSession(orgId, 10000, "k4");
    expect(refused).toMatchObject({ status: "failed", limitReached: true, failure_code: "monthly_charge_limit_reached" });
    expect(charge).toHaveBeenCalledTimes(3);

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const mail = send.mock.calls[0][0];
    expect(mail.eventType).toBe(MONTHLY_CHARGE_LIMIT_REACHED_EVENT);
    expect(mail.recipientEmail).toBe("owner@client.test");
    expect(mail.metadata.ctaUrl).toBe("https://dashboard.distribute.you/v2/orgs/org_clerk1/brands/b1/billing");
    expect(mail.metadata.bodyText).toContain("Your monthly limit is $299.00. Your card was charged $299.00 this month.");
    expect(mail.metadata.bodyText).not.toMatch(/[—–]/);

    // A second refusal the same month: still refused, no second email.
    expect((await reloadOffSession(orgId, 10000, "k5")).limitReached).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(send).toHaveBeenCalledTimes(1);

    const read = await request(app).get(PATH).set(getAuthHeaders(orgId));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      org_id: orgId,
      monthly_charge_limit_cents: 29900,
      period: "calendar_month_utc",
      charged_this_period_cents: 29900,
      remaining_cents: 0,
      limit_reached: true,
      refused_amount_cents: 10000,
    });
  });

  it("raising the limit re-opens the month: the next charge goes out", async () => {
    await setMonthlyChargeLimit(orgId, 10000, null);
    payments.push(payment(10000));
    expect((await reloadOffSession(orgId, 5000, "r1")).limitReached).toBe(true);

    const put = await request(app).put(PATH).set(getAuthHeaders(orgId)).send({ monthly_charge_limit_cents: 20000 });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ monthly_charge_limit_cents: 20000, limit_reached: false, remaining_cents: 10000 });

    expect((await reloadOffSession(orgId, 5000, "r2")).status).toBe("succeeded");
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it("counts succeeded + pending card payments of this UTC month only", async () => {
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
      remaining_cents: null,
      limit_reached: false,
    });
    expect(listPayments).not.toHaveBeenCalled();

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
      limitCents: 29900,
      chargedCents: 29900,
      refusedAmountCents: 10000,
      resetsAt: new Date("2026-11-01T00:00:00Z"),
      ctaUrl: "https://dashboard.distribute.you/x",
    });
    expect(email.subject).toBe("You reached your monthly limit");
    expect(email.bodyText).toContain("They start again on November 1, or right away if you raise your limit.");
    expect(email.bodyHtml.match(/<a /g)?.length).toBe(1);
    expect(email.bodyHtml).not.toMatch(/[—–]/);
  });
});
