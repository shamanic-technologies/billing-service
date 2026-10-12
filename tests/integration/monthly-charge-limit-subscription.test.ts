/**
 * The MONTHLY CHARGE LIMIT on a subscription (lib/monthly-charge-limit), owner's
 * worked example: plan $99, limit $299. Credit out inside the trial → $100 step
 * (total $100); trial end → $199 (total $299); credit out again → the $100 step
 * would make $399, so it is NOT charged: no claim kept, the ONE limit email instead
 * of the out-of-credits email. Raising the limit lets the next check step again.
 * Plus the coalescer: a limit refusal arms no card backoff.
 *
 * Own file (one describe per file — see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { subscriptionAutoUpgrades } from "../../src/db/schema.js";
import * as ssClient from "../../src/lib/stripe-service-client.js";
import * as reload from "../../src/lib/reload.js";
import { advanceSubscription, getLiveSubscription, startSubscription } from "../../src/lib/subscription.js";
import { notifySubscriptionOutOfCreditsIfDue } from "../../src/lib/subscription-out-of-credits.js";
import { setMonthlyChargeLimit, MONTHLY_CHARGE_LIMIT_REACHED_EVENT } from "../../src/lib/monthly-charge-limit.js";
import { coalesceReload, consecutiveReloadFailures, _resetCoalescer } from "../../src/lib/reload-coalescer.js";
import type { SalesFunnelCampaign } from "../../src/lib/funnel-campaigns.js";

const orgId = "00000000-0000-0000-0000-0000000009c1";
const userId = "00000000-0000-0000-0000-0000000009c9";
const brandId = "00000000-0000-0000-0000-0000000009cb";
const offerId = "00000000-0000-0000-0000-0000000009cf";
const DAY = 24 * 60 * 60 * 1000;

const REVOLUT_CARD = {
  object: "saved_payment_method",
  org_id: orgId,
  acquirer: "revolut",
  saved: true,
  method: { id: "rpm_1", type: "card", saved_for: "merchant", funding: "debit", prepaid: false },
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

describe("monthly charge limit on a subscription (auto-upgrade + renewal)", () => {
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
    // The REAL reloadOffSession (the limit lives there); only the acquirer is mocked.
    vi.mocked(reload.reloadOffSession).mockRestore();
    vi.spyOn(ssClient, "chargeOrgOffSession").mockImplementation((async (
      _o: string,
      body: { amount: number; metadata?: Record<string, string> },
      key: string
    ) => {
      charges.push({ amount: body.amount, key, reason: body.metadata?.reason });
      paid += body.amount;
      return { status: "succeeded", reference: `pay_${charges.length}` };
    }) as never);
    ssMocks.listOrgPayments.mockImplementation(async () =>
      charges.map((c, i) => ({
        id: `pay_${i + 1}`,
        acquirer: "revolut",
        amount: c.amount,
        currency: "usd",
        status: "succeeded",
        created: Math.floor(Date.now() / 1000) - 60,
      }))
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
    // The limit email is fire-and-forget: let it settle before the DB closes.
    await new Promise((r) => setTimeout(r, 300));
    await cleanTestData();
    await closeDb();
  });

  async function startTrial(now = new Date()) {
    await insertTestAccount({ orgId });
    return startSubscription({ orgId, userId, monthlyAmountCents: 9900, now });
  }

  it("plan $99, limit $299: $100 + $199 charged, the next $100 is refused, one limit email; raising the limit steps again", async () => {
    const start = new Date(Date.now() - DAY * 1.5);
    const sub = await startTrial(start);
    await setMonthlyChargeLimit(orgId, 29900, userId);

    usage = "9900.0000000000";
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("upgraded");
    const upgraded = (await getLiveSubscription(orgId))!;
    usage = "19900.0000000000";
    const afterTrial = await advanceSubscription(upgraded, new Date(sub.trialEndsAt!.getTime() + 1000));
    expect(afterTrial.status).toBe("active");
    expect(charges.map((c) => c.amount)).toEqual([10000, 19900]);

    // Out of credit again: $299 + $100 > $299.
    usage = "29900.0000000000";
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("monthly_limit_reached");
    expect(charges.map((c) => c.amount)).toEqual([10000, 19900]);
    expect(await db.select().from(subscriptionAutoUpgrades).where(eq(subscriptionAutoUpgrades.orgId, orgId))).toHaveLength(1); // only the paid step
    expect((await getLiveSubscription(orgId))!.monthlyAmountCents).toBe(19900);
    await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(1));
    expect(sendSpy.mock.calls[0][0].eventType).toBe(MONTHLY_CHARGE_LIMIT_REACHED_EVENT);

    // Next check, same month: still refused, still one email.
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("monthly_limit_reached");
    await new Promise((r) => setTimeout(r, 50));
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // The customer raises the limit: the step goes through.
    await setMonthlyChargeLimit(orgId, 39900, userId);
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("upgraded");
    expect(charges.map((c) => c.amount)).toEqual([10000, 19900, 10000]);
    expect((await getLiveSubscription(orgId))!.monthlyAmountCents).toBe(29900);
  });

  it("a renewal the limit refuses consumes no rung and moves nothing (retried next tick)", async () => {
    const start = new Date(Date.now() - 10 * DAY);
    const sub = await startTrial(start);
    await setMonthlyChargeLimit(orgId, 5000, userId);
    const same = await advanceSubscription(sub, new Date(sub.trialEndsAt!.getTime() + 1000));
    expect(charges).toEqual([]);
    expect(same.status).toBe("trialing");
    expect(same.currentPeriodStart.getTime()).toBe(sub.currentPeriodStart.getTime());
  });

  it("a limit refusal arms no card backoff", async () => {
    _resetCoalescer();
    const out = await coalesceReload(orgId, async () => ({ status: "failed" as const, limitReached: true }));
    expect(out.limitReached).toBe(true);
    expect(consecutiveReloadFailures(orgId)).toBe(0);
    _resetCoalescer();
  });
});
