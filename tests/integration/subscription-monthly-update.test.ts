/**
 * The informational monthly update (lib/subscription-monthly-update), owner
 * 2026-10-04: every subscription org gets its results at the END of each period,
 * whatever it consumed, once per period; never while paused; a 3-day trial is not
 * "a month" on its own; the deploy never mails about a period that closed before it.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { readFileSync } from "fs";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db, sql } from "../../src/db/index.js";
import { subscriptions } from "../../src/db/schema.js";
import { advanceSubscription, getLiveSubscription, startSubscription } from "../../src/lib/subscription.js";
import { toSubscriptionRecap, type SubscriptionRecap } from "../../src/lib/subscription-recap-client.js";
import {
  notifySubscriptionMonthlyUpdateIfDue,
  SUBSCRIPTION_MONTHLY_UPDATE_EVENT,
} from "../../src/lib/subscription-monthly-update.js";

const orgId = "00000000-0000-0000-0000-0000000006b1";
const userId = "00000000-0000-0000-0000-0000000006b9";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const REVOLUT_CARD = {
  object: "saved_payment_method",
  org_id: orgId,
  acquirer: "revolut",
  saved: true,
  method: { id: "rpm_1", type: "card", saved_for: "merchant" },
};

function activeRecap(): SubscriptionRecap {
  return toSubscriptionRecap({
    outbound: { emailsSent: 120, recipientsEnrolled: 60, recipientsEmailed: 60, sendStatus: "emails_sent", deliveryRatePct: 95 },
    expectedPositiveReplies: 0.4,
    expectedReturn: { roiMultiple: 0.35 },
  });
}

describe("subscription monthly update", () => {
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let sendSpy: ReturnType<typeof vi.fn>;
  let recapSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@legistai.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");
    ssMocks.getSavedPaymentMethod.mockResolvedValue(REVOLUT_CARD);

    const runsClient = await import("../../src/lib/runs-client.js");
    const usage = { org_id: orgId, spent_cents: "0.0000000000", as_of: "2026-10-01T00:00:00.000Z" };
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue(usage);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue(usage);
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue("00000000-0000-0000-0000-00000000a061");
    vi.spyOn(runsClient, "completePlatformRun").mockResolvedValue(undefined);
    const ctx = await import("../../src/lib/budget-change-context.js");
    vi.spyOn(ctx, "fetchOrgIdentity").mockResolvedValue({ name: "Legistai", externalId: "org_clerk6" });
    const recapClient = await import("../../src/lib/subscription-recap-client.js");
    recapSpy = vi.spyOn(recapClient, "fetchSubscriptionRecap").mockResolvedValue(activeRecap());
    const email = await import("../../src/lib/email-client.js");
    sendSpy = vi.fn();
    vi.spyOn(email, "sendEmail").mockImplementation(sendSpy);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  async function startTrial(now = new Date()) {
    await insertTestAccount({ orgId });
    return startSubscription({ orgId, userId, monthlyAmountCents: 9900, now });
  }

  /** Trial end (3 days) + the first paid month: the first full window closes. */
  async function throughFirstMonth(trialStart: Date) {
    let sub = (await getLiveSubscription(orgId))!;
    sub = await advanceSubscription(sub, new Date(sub.currentPeriodEnd.getTime() + HOUR));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("9900.0000000000");
    const t = new Date(sub.currentPeriodEnd.getTime() + HOUR);
    sub = await advanceSubscription(sub, t);
    expect(sub.currentPeriodStart.getTime() - trialStart.getTime()).toBeGreaterThan(28 * DAY);
    return sub;
  }

  const notify = async () => notifySubscriptionMonthlyUpdateIfDue(orgId, await getLiveSubscription(orgId));

  it("nothing while the first period is open", async () => {
    await startTrial();
    await notify();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(recapSpy).not.toHaveBeenCalled();
  });

  it("the 3-day trial ending is not a month: it rolls into the next report", async () => {
    const sub = await startTrial();
    await advanceSubscription(sub, new Date(sub.currentPeriodEnd.getTime() + HOUR));
    expect((await getLiveSubscription(orgId))!.status).toBe("active");
    await notify();
    expect(sendSpy).not.toHaveBeenCalled();
    expect((await getLiveSubscription(orgId))!.monthlyUpdateReportedThrough).toBeNull();
  });

  it("once the first month closes: one email over the whole window, results only, then never again for it", async () => {
    const trialStart = new Date(Date.now() - 40 * DAY);
    await startTrial(trialStart);
    const sub = await throughFirstMonth(trialStart);

    await notify();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = sendSpy.mock.calls[0][0];
    expect(sent.eventType).toBe(SUBSCRIPTION_MONTHLY_UPDATE_EVENT);
    expect(sent.recipientEmail).toBe("founder@legistai.test");
    expect(sent.metadata.ctaUrl).toBe("https://dashboard.distribute.you/orgs/org_clerk6");
    expect(sent.metadata.bodyText).toContain("still learning");
    expect(JSON.stringify(sent.metadata)).not.toMatch(/\$100|Add more revenue|invested/);

    // The window is [trial start, current period start), as inclusive UTC days.
    const [, from, to] = recapSpy.mock.calls[0];
    expect((from as Date).getTime()).toBe(trialStart.getTime());
    expect((to as Date).getTime()).toBe(sub.currentPeriodStart.getTime() - 1);
    expect((await getLiveSubscription(orgId))!.monthlyUpdateReportedThrough!.getTime()).toBe(
      sub.currentPeriodStart.getTime()
    );

    await notify();
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("never while paused", async () => {
    const trialStart = new Date(Date.now() - 40 * DAY);
    await startTrial(trialStart);
    await throughFirstMonth(trialStart);
    await db.update(subscriptions).set({ pausedAt: new Date() }).where(eq(subscriptions.orgId, orgId));
    await notify();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("an unreadable recap leaves the period unclaimed, retried next tick", async () => {
    const trialStart = new Date(Date.now() - 40 * DAY);
    await startTrial(trialStart);
    await throughFirstMonth(trialStart);
    recapSpy.mockResolvedValueOnce(null);
    await notify();
    expect(sendSpy).not.toHaveBeenCalled();
    expect((await getLiveSubscription(orgId))!.monthlyUpdateReportedThrough).toBeNull();
    await notify();
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("a period with nothing lined up or sent is closed without a mail", async () => {
    const trialStart = new Date(Date.now() - 40 * DAY);
    await startTrial(trialStart);
    const sub = await throughFirstMonth(trialStart);
    recapSpy.mockResolvedValue(
      toSubscriptionRecap({ outbound: { emailsSent: 0, recipientsEnrolled: 0, sendStatus: "nothing_sent" } })
    );
    await notify();
    expect(sendSpy).not.toHaveBeenCalled();
    expect((await getLiveSubscription(orgId))!.monthlyUpdateReportedThrough!.getTime()).toBe(
      sub.currentPeriodStart.getTime()
    );
  });

  it("migration 0061 marks existing plans as reported through their current period, and a replay moves nothing", async () => {
    const trialStart = new Date(Date.now() - 40 * DAY);
    await startTrial(trialStart);
    const sub = await throughFirstMonth(trialStart);
    await db.update(subscriptions).set({ monthlyUpdateReportedThrough: null }).where(eq(subscriptions.id, sub.id));

    const migration = readFileSync(new URL("../../drizzle/0061_subscription_monthly_update.sql", import.meta.url), "utf8");
    const replay = async () => {
      for (const statement of migration.split("--> statement-breakpoint")) {
        const body = statement.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
        if (body) await sql.unsafe(body);
      }
    };
    await replay();
    expect((await getLiveSubscription(orgId))!.monthlyUpdateReportedThrough!.getTime()).toBe(
      sub.currentPeriodStart.getTime()
    );
    // The deploy mails nobody about a period that closed before it.
    await notify();
    expect(sendSpy).not.toHaveBeenCalled();

    const later = new Date(sub.currentPeriodStart.getTime() + 5 * DAY);
    await db.update(subscriptions).set({ monthlyUpdateReportedThrough: later }).where(eq(subscriptions.id, sub.id));
    await replay();
    expect((await getLiveSubscription(orgId))!.monthlyUpdateReportedThrough!.getTime()).toBe(later.getTime());
  });
});
