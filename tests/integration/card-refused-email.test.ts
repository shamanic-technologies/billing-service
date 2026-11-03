/**
 * REFUSED-CARD-EMAIL-EACH-1103: every REAL charge attempt the bank refuses mails
 * the customer, once, whichever path asked; an attempt that never reached the
 * bank mails nothing; the mail can never trigger a charge.
 *
 * Prod 2026-11-03, Beyond Logic (postpaid): three $50 charges refused for
 * insufficient funds through usage_apply, and no email at all.
 *
 * The real `reloadOffSession` runs here (setupStripeMocks replaces it); the
 * acquirer is stubbed one level down, at stripe-service's charge route.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { readFileSync } from "fs";
import request from "supertest";
import { sql } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import * as reload from "../../src/lib/reload.js";
import * as ssClient from "../../src/lib/stripe-service-client.js";
import * as runsClient from "../../src/lib/runs-client.js";
import * as emailClient from "../../src/lib/email-client.js";
import * as budgetContext from "../../src/lib/budget-change-context.js";
import * as subscriptionPlans from "../../src/lib/subscription-plans.js";
import * as costsClient from "../../src/lib/costs-client.js";
import { db } from "../../src/db/index.js";
import { PLATFORM_USER_ID } from "../../src/db/schema.js";
import {
  CARD_REFUSED_EVENT,
  flushCardRefusedEmails,
  composeCardRefusedEmail,
} from "../../src/lib/card-refused-email.js";
import { runCampaignReloadSweep } from "../../src/lib/campaign-reload-sweep.js";
import { runMonthEndSweep, SWEEP_HOUR_UTC } from "../../src/lib/month-end-sweep.js";
import { chargeOrgOnDemand } from "../../src/lib/on-demand-charge.js";
import { upsertCampaignAuthorizeCost } from "../../src/lib/campaign-costs.js";

// Captured before any spy replaces it.
const realReloadOffSession = reload.reloadOffSession;

const app = createTestApp();
const orgId = "8c043fa7-88b9-4e92-a96b-3dab875cb465";
const userId = "00000000-0000-0000-0000-000000000099";
const campaignId = "00000000-0000-0000-0000-00000000ca01";
const billingEmail = "owner@beyondlogic.test";
const BANK_REASON = "Your card has insufficient funds.";
const RUN_ID = "99999999-9999-4999-8999-999999999999";

describe("every refused charge mails the customer", () => {
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let chargeMock: ReturnType<typeof vi.fn>;
  let sendMock: ReturnType<typeof vi.fn>;
  let usageCents: string;
  let refNo: number;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    ssMocks.reloadOffSession.mockImplementation(realReloadOffSession);
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail(billingEmail));
    await cleanTestData();
    await db.execute(sql`DELETE FROM card_refusal_emails`);

    refNo = 0;
    // Each real attempt gets its own acquirer reference, like the bank's.
    chargeMock = vi.fn().mockImplementation(async (org: string, body: { amount: number }) => ({
      object: "charge_result",
      org_id: org,
      acquirer: "stripe",
      reference: `pi_refused_${++refNo}`,
      status: "failed",
      amount: body.amount,
      currency: "usd",
      hosted_document_url: null,
      failure: { type: "card_error", code: "insufficient_funds", message: BANK_REASON },
    }));
    vi.spyOn(ssClient, "chargeOrgOffSession").mockImplementation(chargeMock as never);

    usageCents = "0.0000000000";
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async (org: string) => ({
      org_id: org,
      spent_cents: usageCents,
      as_of: "x",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async () => ({
      spent_cents: usageCents,
    }));
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue(RUN_ID as never);
    vi.spyOn(runsClient, "completePlatformRun").mockResolvedValue(undefined as never);
    vi.spyOn(budgetContext, "fetchOrgIdentity").mockResolvedValue({
      externalId: "org_clerk_beyond",
    } as never);
    vi.spyOn(subscriptionPlans, "fetchOrgBrandIdsOldestFirst").mockResolvedValue([
      "00000000-0000-0000-0000-0000000b4a4d",
    ]);
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue("10.0000000000");
    sendMock = vi.fn();
    vi.spyOn(emailClient, "sendEmail").mockImplementation(sendMock as never);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  /** Postpaid, $0 paid, $50.01 billed: past the $50 line. */
  async function owing() {
    await insertTestAccount({ orgId, topupAmountCents: 1000, topupThresholdCents: 500 });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    usageCents = "5001.0000000000";
  }

  function refusalMails() {
    return sendMock.mock.calls.map((c) => c[0]).filter((p) => p.eventType === CARD_REFUSED_EVENT);
  }

  function expectOneRefusalMail(amountCents: number) {
    const mails = refusalMails();
    expect(mails).toHaveLength(1);
    const mail = mails[0];
    expect(mail.orgId).toBe(orgId);
    expect(mail.recipientEmail).toBe(billingEmail);
    expect(mail.metadata.subject).toBe("Your card was refused");
    expect(mail.metadata.bodyText).toContain(`$${(amountCents / 100).toFixed(2)}`);
    expect(mail.metadata.bodyText).toContain(BANK_REASON);
    expect(mail.metadata.ctaUrl).toBe(
      "https://dashboard.distribute.you/v2/orgs/org_clerk_beyond/brands/00000000-0000-0000-0000-0000000b4a4d/billing"
    );
  }

  it("usage_apply (the Beyond Logic path): a refused charge mails once", async () => {
    await owing();
    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId, userId))
      .send({ spent_total_cents: "5001.0000000000" });
    expect(res.status).toBe(202);
    await flushCardRefusedEmails();
    expect(chargeMock).toHaveBeenCalledTimes(1);
    expectOneRefusalMail(5001);
  });

  it("authorize reload: a refused charge mails once, and the route sends no second mail", async () => {
    await owing();
    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId, userId), "x-campaign-id": campaignId })
      .send({ items: [{ costName: "anthropic-sonnet-4-5-tokens-input", quantity: 1000 }], description: "t" });
    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
    await flushCardRefusedEmails();
    expect(chargeMock).toHaveBeenCalledTimes(1);
    expectOneRefusalMail(chargeMock.mock.calls[0][1].amount);
    // Nothing else about the card went out (the old route-level send is gone).
    expect(sendMock.mock.calls.filter((c) => c[0].eventType === CARD_REFUSED_EVENT)).toHaveLength(1);
  });

  it("a backoff-skipped attempt (no call to the bank) mails nothing", async () => {
    await owing();
    const body = { spent_total_cents: "5001.0000000000" };
    await request(app).post("/v1/customer_balance/usage_apply").set(getAuthHeaders(orgId, userId)).send(body);
    // Right after a refusal the coalescer's cooldown skips the next attempt.
    await request(app).post("/v1/customer_balance/usage_apply").set(getAuthHeaders(orgId, userId)).send(body);
    await flushCardRefusedEmails();
    expect(chargeMock).toHaveBeenCalledTimes(1);
    expect(refusalMails()).toHaveLength(1);
  });

  it("blocked-campaign reload sweep: a refused charge mails once", async () => {
    await owing();
    await upsertCampaignAuthorizeCost(campaignId, orgId, "11.8000000000");
    await runCampaignReloadSweep(new Date());
    await flushCardRefusedEmails();
    expect(chargeMock).toHaveBeenCalledTimes(1);
    expectOneRefusalMail(chargeMock.mock.calls[0][1].amount);
  });

  it("month-end settle: a refused charge mails once", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 1000, topupThresholdCents: 500 });
    usageCents = "100.0000000000";
    await runMonthEndSweep(new Date(Date.UTC(2026, 0, 31, SWEEP_HOUR_UTC, 0, 0)));
    await flushCardRefusedEmails();
    expect(chargeMock).toHaveBeenCalledTimes(1);
    expectOneRefusalMail(100);
  });

  it("card change: a refused settle mails once, and the session still opens", async () => {
    await insertTestAccount({ orgId });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("1000.0000000000");
    usageCents = "6000.0000000000";
    const res = await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });
    expect(res.status).toBe(200);
    await flushCardRefusedEmails();
    expect(chargeMock).toHaveBeenCalledTimes(1);
    expectOneRefusalMail(5000);
  });

  it("on-demand charge: a refused charge mails once", async () => {
    await insertTestAccount({ orgId });
    await chargeOrgOnDemand(orgId, 5000).catch(() => undefined);
    await flushCardRefusedEmails();
    expect(chargeMock).toHaveBeenCalledTimes(1);
    expectOneRefusalMail(5000);
  });

  it("every refused attempt is news: two refusals = two mails; a replay of the SAME charge = none", async () => {
    await insertTestAccount({ orgId });
    await reload.reloadOffSession(orgId, 5000, "key-1");
    await reload.reloadOffSession(orgId, 5000, "key-2");
    await flushCardRefusedEmails();
    expect(refusalMails()).toHaveLength(2);
    // stripe-service answers an idempotent replay with the same charge reference.
    chargeMock.mockImplementationOnce(async (org: string, body: { amount: number }) => ({
      object: "charge_result",
      org_id: org,
      acquirer: "stripe",
      reference: "pi_refused_2",
      status: "failed",
      amount: body.amount,
      currency: "usd",
      hosted_document_url: null,
      failure: { type: "card_error", code: "insufficient_funds", message: BANK_REASON },
    }));
    await reload.reloadOffSession(orgId, 5000, "key-2");
    await flushCardRefusedEmails();
    expect(refusalMails()).toHaveLength(2);
  });

  it("a charge that went through mails nothing", async () => {
    await insertTestAccount({ orgId });
    chargeMock.mockResolvedValue({
      object: "charge_result",
      org_id: orgId,
      acquirer: "stripe",
      reference: "pi_ok",
      status: "succeeded",
      amount: 5000,
      currency: "usd",
      hosted_document_url: null,
    });
    await reload.reloadOffSession(orgId, 5000, "key-ok");
    await flushCardRefusedEmails();
    expect(refusalMails()).toHaveLength(0);
  });

  it("no send loop: the mail is platform-paid and the send never charges", async () => {
    await insertTestAccount({ orgId });
    // A send that re-entered a charge would show up as a second acquirer call.
    sendMock.mockImplementation(() => undefined);
    await reload.reloadOffSession(orgId, 5000, "key-loop");
    await flushCardRefusedEmails();
    expect(chargeMock).toHaveBeenCalledTimes(1);
    const [mail] = refusalMails();
    // The platform pays for it (postmark-service PLATFORM_LIFECYCLE_TAGS holds
    // `credits-reload-failed`): it rides the platform sentinel and a platform run,
    // so it authorizes nothing on the org it is about.
    expect(mail.eventType).toBe("credits-reload-failed");
    expect(mail.userId).toBe(PLATFORM_USER_ID);
    expect(mail.runId).toBe(RUN_ID);
    // And the mailer cannot reach a charge or an authorize by construction.
    const src = readFileSync(new URL("../../src/lib/card-refused-email.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from "\.\/(reload|reload-coalescer|on-demand-charge|card-change-settlement)\.js"/);
    expect(src).not.toMatch(/customer_balance/);
  });

  it("every charge goes through lib/reload, so no path can skip the mail", () => {
    const { execSync } = require("child_process") as typeof import("child_process");
    const callers = execSync(`git grep -l "chargeOrgOffSession(" -- src`, { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(callers).toEqual(["src/lib/reload.ts", "src/lib/stripe-service-client.ts"]);
  });

  it("a permanent refusal says the card will not be tried again, in one mail", async () => {
    await insertTestAccount({ orgId });
    chargeMock.mockResolvedValueOnce({
      object: "charge_result",
      org_id: orgId,
      acquirer: "stripe",
      reference: "pi_stolen",
      status: "failed",
      amount: 5000,
      currency: "usd",
      hosted_document_url: null,
      failure: { type: "card_error", code: "stolen_card", message: "Your card was declined." },
    });
    await reload.reloadOffSession(orgId, 5000, "key-stolen");
    await flushCardRefusedEmails();
    const mails = refusalMails();
    expect(mails).toHaveLength(1);
    expect(mails[0].metadata.bodyText).toContain("we will not try it again");
  });

  it("copy has no dash, even when the bank's sentence carries one", () => {
    const email = composeCardRefusedEmail({
      amountCents: 5000,
      bankReason: "Declined — contact your bank",
      permanent: false,
      ctaUrl: "https://dashboard.distribute.you",
    });
    expect(email.bodyText).not.toMatch(/[—–]/);
    expect(email.bodyHtml).not.toMatch(/[—–]/);
  });
});
