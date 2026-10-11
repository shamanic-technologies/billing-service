/**
 * AUTO-UPGRADE when a subscriber's credit runs out (lib/subscription-auto-upgrade,
 * owner 2026-10-11, migration 0081). Pins the owner-confirmed worked example: $99
 * plan, 3-day trial, credit empty on day ~1.5 → $100 charged now, plan $199; trial
 * end → $199 charged. $299 over three days. Plus: after the trial, the grandfathered
 * plan, a refused card, a race, nothing running, an outage, and the migration's
 * grandfather replay.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { readFileSync } from "fs";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { subscriptionAutoUpgrades, subscriptions } from "../../src/db/schema.js";
import { advanceSubscription, getLiveSubscription, startSubscription } from "../../src/lib/subscription.js";
import { computeBalance } from "../../src/lib/balance.js";
import { notifySubscriptionOutOfCreditsIfDue } from "../../src/lib/subscription-out-of-credits.js";
import {
  AUTO_UPGRADE_CHARGE_REASON,
  STALE_PENDING_MS,
  resumeStaleAutoUpgrades,
  tryAutoUpgrade,
} from "../../src/lib/subscription-auto-upgrade.js";
import type { SalesFunnelCampaign } from "../../src/lib/funnel-campaigns.js";

const orgId = "00000000-0000-0000-0000-0000000009a1";
const userId = "00000000-0000-0000-0000-0000000009a9";
const brandId = "00000000-0000-0000-0000-0000000009ab";
const offerId = "00000000-0000-0000-0000-0000000009af";
const DAY = 24 * 60 * 60 * 1000;

const REVOLUT_CARD = {
  object: "saved_payment_method",
  org_id: orgId,
  acquirer: "revolut",
  saved: true,
  method: { id: "rpm_1", type: "card", saved_for: "merchant" },
};

function ongoing(status = "ongoing") {
  return {
    campaignId: "c1",
    orgId,
    brandId,
    offerId,
    legKey: "lead_found_to_conversation",
    featureSlug: "sales-cold-email-outreach",
    status,
    running: status === "ongoing",
    executedByPlatform: true,
    kind: "proactive" as const,
    audience: "available" as const,
    allAudiencesExhausted: false,
    recurring: status === "ongoing",
  };
}

describe("subscription auto-upgrade", () => {
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let sendSpy: ReturnType<typeof vi.fn>;
  let usage = "0.0000000000";
  let paid = 0;
  let charges: Array<{ amount: number; key: string; reason?: string }> = [];
  let campaignStatus: "ongoing" | "stopped" | "unreadable" = "ongoing";

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    usage = "0.0000000000";
    paid = 0;
    charges = [];
    campaignStatus = "ongoing";
    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@auto.test"));
    ssMocks.sumSucceededTopupsForOrg.mockImplementation(async () => `${paid}.0000000000`);
    ssMocks.reloadOffSession.mockImplementation(
      async (_o: string, amount: number, key: string, meta?: Record<string, string>) => {
        charges.push({ amount, key, reason: meta?.reason });
        paid += amount;
        return { status: "succeeded", reference: `pay_${charges.length}` };
      }
    );
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");
    ssMocks.getSavedPaymentMethod.mockResolvedValue(REVOLUT_CARD);

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async (o: string) => ({
      org_id: o,
      spent_cents: usage,
      as_of: "2026-10-11T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async (o: string) => ({
      org_id: o,
      spent_cents: usage,
      as_of: "2026-10-11T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue("00000000-0000-0000-0000-00000000a091");
    vi.spyOn(runsClient, "completePlatformRun").mockResolvedValue(undefined);
    const campaignClient = await import("../../src/lib/campaign-service-client.js");
    vi.spyOn(campaignClient, "fetchRecurringCampaignStatuses").mockImplementation(async () =>
      campaignStatus === "unreadable"
        ? { ok: false as const, reason: "campaign_service_unavailable" as const }
        : { ok: true as const, campaigns: [ongoing(campaignStatus)] }
    );
    const ctx = await import("../../src/lib/budget-change-context.js");
    vi.spyOn(ctx, "fetchOrgIdentity").mockResolvedValue({ name: "Acme", externalId: "org_clerk9" });
    vi.spyOn(ctx, "fetchBrandName").mockResolvedValue("Acme");
    vi.spyOn(ctx, "fetchOfferNames").mockResolvedValue(new Map([[offerId, "Acme offer"]]));
    const fc = await import("../../src/lib/funnel-campaigns.js");
    const funnel: SalesFunnelCampaign = {
      id: "fc1",
      brandId,
      offerId,
      salesFunnelId: "funnel-cold",
      salesFunnelName: "Bliss",
      status: "ongoing",
      units: [],
    };
    vi.spyOn(fc, "fetchSalesFunnelCampaigns").mockResolvedValue({ ok: true, campaigns: [funnel] });
    const cat = await import("../../src/lib/sales-funnel-catalogue.js");
    vi.spyOn(cat, "getSalesFunnel").mockImplementation(async (id: string) => ({
      id,
      name: null,
      type: "proactive",
      pipes: [],
    }));
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

  it("a new subscription auto-upgrades; the plans that existed before do not", async () => {
    const sub = await startTrial();
    expect(sub.autoUpgrade).toBe(true);
  });

  it("owner's worked example: inside the trial $100 now, plan $199, trial end $199: $299 charged", async () => {
    const start = new Date(Date.now() - DAY * 1.5);
    const sub = await startTrial(start);
    usage = "9900.0000000000"; // the $99 trial credit is spent on day ~1.5

    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("upgraded");
    expect(charges).toEqual([
      { amount: 10000, key: expect.stringContaining(`subscription-upgrade:${sub.id}:`), reason: AUTO_UPGRADE_CHARGE_REASON },
    ]);
    const upgraded = (await getLiveSubscription(orgId))!;
    expect(upgraded.status).toBe("trialing");
    expect(upgraded.monthlyAmountCents).toBe(19900);
    expect(upgraded.currentPeriodEnd.getTime()).toBe(sub.currentPeriodEnd.getTime()); // trial end unchanged
    expect(sendSpy).not.toHaveBeenCalled(); // no "out of credits" email
    // The $100 is credit right away (money paid IS the credit), not a trial repayment.
    expect(Number((await computeBalance(orgId)).balanceCents)).toBe(10000);

    // Day 3: the trial ends, the first paid month is charged at the NEW plan.
    usage = "19900.0000000000";
    const afterTrial = await advanceSubscription(upgraded, new Date(sub.trialEndsAt!.getTime() + 1000));
    expect(afterTrial.status).toBe("active");
    expect(charges.map((c) => c.amount)).toEqual([10000, 19900]);
    expect(paid).toBe(29900);
    // $199 paid at trial end: $99 repays the trial, $100 lands.
    expect(Number((await computeBalance(orgId)).balanceCents)).toBe(10000);
  });

  it("after the trial: one step per run-out, the period does not restart", async () => {
    const start = new Date(Date.now() - 10 * DAY);
    const sub = await startTrial(start);
    usage = "0.0000000000";
    const active = await advanceSubscription(sub, new Date(sub.trialEndsAt!.getTime() + 1000));
    expect(active.status).toBe("active");
    // Spend everything credited so far: 9900 trial + 9900 paid − 9900 repaid.
    usage = "9900.0000000000";
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("upgraded");
    let live = (await getLiveSubscription(orgId))!;
    expect(live.monthlyAmountCents).toBe(19900);
    expect(live.currentPeriodStart.getTime()).toBe(active.currentPeriodStart.getTime());
    // Still has the step's credit: nothing more.
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("has_credit");
    // Out again in the same period: the next step.
    usage = "19900.0000000000";
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("upgraded");
    live = (await getLiveSubscription(orgId))!;
    expect(live.monthlyAmountCents).toBe(29900);
    expect(charges.map((c) => c.amount)).toEqual([9900, 10000, 10000]);
  });

  it("grandfathered plan (auto_upgrade false): no charge at zero, the email instead", async () => {
    const sub = await startTrial();
    await db.update(subscriptions).set({ autoUpgrade: false }).where(eq(subscriptions.id, sub.id));
    usage = "9900.0000000000";
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("sent");
    expect(charges).toEqual([]);
    expect((await getLiveSubscription(orgId))!.monthlyAmountCents).toBe(9900);
  });

  it("refused card: sending stops, the customer is told the card was refused, no retry this period", async () => {
    await startTrial();
    usage = "9900.0000000000";
    ssMocks.reloadOffSession.mockImplementation(async (_o: string, amount: number, key: string) => {
      charges.push({ amount, key });
      return { status: "failed", failure_code: "insufficient_funds", reference: "pay_x" };
    });
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("sent");
    expect(charges.length).toBe(1);
    expect((await getLiveSubscription(orgId))!.monthlyAmountCents).toBe(9900);
    const text: string = sendSpy.mock.calls[0][0].metadata.bodyText;
    expect(text).toContain("your card was refused");
    expect(text).not.toMatch(/[–—]/);
    // No second attempt, no second email.
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("already_notified");
    expect(charges.length).toBe(1);
    expect((await computeBalance(orgId)).balanceCents).toBe("0.0000000000");
  });

  it("two triggers at once: one charge", async () => {
    await startTrial();
    usage = "9900.0000000000";
    const results = await Promise.all([
      notifySubscriptionOutOfCreditsIfDue(orgId),
      notifySubscriptionOutOfCreditsIfDue(orgId),
      notifySubscriptionOutOfCreditsIfDue(orgId),
    ]);
    expect(results.filter((r) => r === "upgraded").length).toBe(1);
    expect(charges.length).toBe(1);
    expect((await getLiveSubscription(orgId))!.monthlyAmountCents).toBe(19900);
  });

  it("nothing running: no charge", async () => {
    const sub = await startTrial();
    usage = "9900.0000000000";
    campaignStatus = "stopped";
    expect(await tryAutoUpgrade(sub)).toEqual({ result: "not_eligible", reason: "nothing_running" });
    campaignStatus = "unreadable";
    expect((await tryAutoUpgrade(sub)).result).toBe("unavailable");
    expect(charges).toEqual([]);
  });

  it("no answer from the acquirer: kept pending, re-issued later with the SAME key", async () => {
    const sub = await startTrial();
    usage = "9900.0000000000";
    ssMocks.reloadOffSession.mockImplementationOnce(async (_o: string, amount: number, key: string) => {
      charges.push({ amount, key });
      throw new Error("stripe-service POST /internal/charges failed: 503 down");
    });
    expect((await tryAutoUpgrade(sub)).result).toBe("unavailable");
    expect((await tryAutoUpgrade(sub)).result).toBe("in_flight");
    const [pending] = await db.select().from(subscriptionAutoUpgrades);
    expect(pending.status).toBe("pending");

    expect(await resumeStaleAutoUpgrades(new Date(Date.now() + STALE_PENDING_MS + 1000))).toBe(1);
    expect(charges.length).toBe(2);
    expect(charges[1].key).toBe(charges[0].key);
    expect((await getLiveSubscription(orgId))!.monthlyAmountCents).toBe(19900);
  });

  it("paused or cancel pending: never upgraded", async () => {
    const sub = await startTrial();
    usage = "9900.0000000000";
    await db.update(subscriptions).set({ cancelAtPeriodEnd: true }).where(eq(subscriptions.id, sub.id));
    const live = (await getLiveSubscription(orgId))!;
    expect(await tryAutoUpgrade(live)).toEqual({ result: "not_eligible", reason: "sending_stopped" });
    expect(charges).toEqual([]);
  });

  it("migration 0081 replayed: an existing plan keeps false, a new plan gets true", async () => {
    const sub = await startTrial();
    await db.update(subscriptions).set({ autoUpgrade: false }).where(eq(subscriptions.id, sub.id));
    const { sql: client } = await import("../../src/db/index.js");
    const migration = readFileSync(
      new URL("../../drizzle/0081_subscription_auto_upgrade_and_consents.sql", import.meta.url),
      "utf8"
    );
    for (let pass = 0; pass < 2; pass += 1) {
      for (const statement of migration.split("--> statement-breakpoint")) {
        const body = statement
          .split("\n")
          .filter((l) => !l.trim().startsWith("--"))
          .join("\n")
          .trim();
        if (body) await client.unsafe(body);
      }
    }
    expect((await getLiveSubscription(orgId))!.autoUpgrade).toBe(false);
    const [row] = (await client.unsafe(
      `SELECT column_default FROM information_schema.columns WHERE table_name = 'subscriptions' AND column_name = 'auto_upgrade'`
    )) as unknown as Array<{ column_default: string }>;
    expect(row.column_default).toBe("true");
  });
});
