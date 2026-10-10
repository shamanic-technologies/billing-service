/**
 * The subscription "out of credits" email (lib/subscription-out-of-credits, owner
 * 2026-10-10): a subscription org whose credit runs out is told ONCE per period,
 * its stopped REACTIVE campaigns listed first, then the PROACTIVE ones, with one
 * upgrade button. Never for a prepaid org, never while it still has credit, never
 * twice for the same episode; an upgrade (new period) re-arms it.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { getLiveSubscription, startSubscription, startSubscriptionNow } from "../../src/lib/subscription.js";
import {
  notifySubscriptionOutOfCreditsIfDue,
  runSubscriptionOutOfCreditsCheck,
  SUBSCRIPTION_OUT_OF_CREDITS_EVENT,
} from "../../src/lib/subscription-out-of-credits.js";
import { composeOutOfCreditsEmail } from "../../src/lib/subscription-out-of-credits-email.js";
import type { SalesFunnelCampaign } from "../../src/lib/funnel-campaigns.js";

const orgId = "00000000-0000-0000-0000-0000000008c1";
const prepaidOrgId = "00000000-0000-0000-0000-0000000008c2";
const userId = "00000000-0000-0000-0000-0000000008c9";
const brandId = "00000000-0000-0000-0000-0000000008cb";
const offerId = "00000000-0000-0000-0000-0000000008cf";

const REVOLUT_CARD = {
  object: "saved_payment_method",
  org_id: orgId,
  acquirer: "revolut",
  saved: true,
  method: { id: "rpm_1", type: "card", saved_for: "merchant" },
};

function funnelCampaign(id: string, funnelId: string, name: string, status = "ongoing"): SalesFunnelCampaign {
  return { id, brandId, offerId, salesFunnelId: funnelId, salesFunnelName: name, status, units: [] };
}

describe("subscription out of credits email", () => {
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let sendSpy: ReturnType<typeof vi.fn>;
  let usage = "0.0000000000";
  let paid = 0;
  let campaignsAnswer: { ok: true; campaigns: SalesFunnelCampaign[] } | { ok: false; reason: "campaign_service_unavailable" };

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    usage = "0.0000000000";
    paid = 0;
    campaignsAnswer = {
      ok: true,
      campaigns: [
        funnelCampaign("fc1", "funnel-cold", "Bliss"),
        funnelCampaign("fc2", "funnel-meeting", "Motivate"),
        funnelCampaign("fc3", "funnel-stopped", "Epiphany", "stopped"),
      ],
    };
    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@legistai.test"));
    ssMocks.sumSucceededTopupsForOrg.mockImplementation(async () => `${paid}.0000000000`);
    ssMocks.reloadOffSession.mockImplementation(async (_o: string, amount: number) => {
      paid += amount;
      return { status: "succeeded", reference: "pi_mock" };
    });
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");
    ssMocks.getSavedPaymentMethod.mockResolvedValue(REVOLUT_CARD);

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async (o: string) => ({
      org_id: o,
      spent_cents: usage,
      as_of: "2026-10-01T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async (o: string) => ({
      org_id: o,
      spent_cents: usage,
      as_of: "2026-10-01T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue("00000000-0000-0000-0000-00000000a081");
    vi.spyOn(runsClient, "completePlatformRun").mockResolvedValue(undefined);
    const ctx = await import("../../src/lib/budget-change-context.js");
    vi.spyOn(ctx, "fetchOrgIdentity").mockResolvedValue({ name: "Legistai", externalId: "org_clerk8" });
    vi.spyOn(ctx, "fetchBrandName").mockResolvedValue("Legistai");
    vi.spyOn(ctx, "fetchOfferNames").mockResolvedValue(new Map([[offerId, "LegistAI"]]));
    const fc = await import("../../src/lib/funnel-campaigns.js");
    vi.spyOn(fc, "fetchSalesFunnelCampaigns").mockImplementation(async () => campaignsAnswer);
    const cat = await import("../../src/lib/sales-funnel-catalogue.js");
    vi.spyOn(cat, "getSalesFunnel").mockImplementation(async (id: string) => ({
      id,
      name: null,
      type: id === "funnel-meeting" ? "reactive" : "proactive",
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

  async function startTrial() {
    await insertTestAccount({ orgId });
    return startSubscription({ orgId, userId, monthlyAmountCents: 9900 });
  }

  it("credit at zero: exactly one email, reactive campaigns first, then proactive, one upgrade link", async () => {
    await startTrial();
    usage = "9900.0000000000"; // the $99 trial credit is spent
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("sent");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0][0];
    expect(call.eventType).toBe(SUBSCRIPTION_OUT_OF_CREDITS_EVENT);
    expect(call.recipientEmail).toBe("founder@legistai.test");
    const text: string = call.metadata.bodyText;
    expect(text.indexOf("Motivate")).toBeGreaterThan(0);
    expect(text.indexOf("Motivate")).toBeLessThan(text.indexOf("Bliss"));
    // A stopped campaign is not listed: it was not stopped by the run-out.
    expect(text).not.toContain("Epiphany");
    expect(call.metadata.ctaUrl).toBe(
      `https://dashboard.distribute.you/v2/orgs/org_clerk8/brands/${brandId}/billing`
    );
    expect((call.metadata.bodyHtml.match(/<a /g) ?? []).length).toBe(1);

    // Same episode: no second email, from any trigger.
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("already_notified");
    await runSubscriptionOutOfCreditsCheck();
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("an upgrade starts a new period: a later run-out is a new episode", async () => {
    await startTrial();
    usage = "9900.0000000000";
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("sent");
    await startSubscriptionNow(orgId, 29900);
    // $299 paid: $99 repays the trial, $200 lands. Spent too: out again.
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("has_credit");
    usage = "29900.0000000000";
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("sent");
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it("still has credit: nothing", async () => {
    await startTrial();
    usage = "5000.0000000000";
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("has_credit");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("campaigns unreadable: not claimed, the next check sends", async () => {
    await startTrial();
    usage = "9900.0000000000";
    campaignsAnswer = { ok: false, reason: "campaign_service_unavailable" };
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("unresolved");
    expect((await getLiveSubscription(orgId))!.creditsUsedNotifiedPeriodStart).toBeNull();
    campaignsAnswer = { ok: true, campaigns: [funnelCampaign("fc1", "funnel-cold", "Bliss")] };
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("sent");
  });

  it("nothing running: nothing stopped, no email, not claimed", async () => {
    await startTrial();
    usage = "9900.0000000000";
    campaignsAnswer = { ok: true, campaigns: [funnelCampaign("fc3", "funnel-stopped", "Epiphany", "stopped")] };
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("nothing_running");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("a paused plan: sending already stopped, no email", async () => {
    await startTrial();
    usage = "9900.0000000000";
    const { pauseSubscription } = await import("../../src/lib/subscription.js");
    await pauseSubscription(orgId, 1);
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("sending_stopped");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("a prepaid org out of credit gets no such email", async () => {
    await insertTestAccount({ orgId: prepaidOrgId });
    usage = "100000.0000000000";
    expect(await notifySubscriptionOutOfCreditsIfDue(prepaidOrgId)).toBe("not_subscription");
    await runSubscriptionOutOfCreditsCheck();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("copy: plain English, no em or en dashes, trial wording", () => {
    const email = composeOutOfCreditsEmail({
      campaigns: [
        { name: "Bliss", kind: "proactive" },
        { name: "Motivate", kind: "reactive" },
        { name: "Moving", kind: null },
      ],
      brandName: "Legistai",
      trialing: true,
      monthlyAmountCents: 9900,
      ctaUrl: "https://dashboard.distribute.you/v2/orgs/o/brands/b/billing",
    });
    expect(email.subject).toBe("Your campaigns for Legistai have stopped");
    for (const part of [email.subject, email.bodyHtml, email.bodyText]) {
      expect(part).not.toMatch(/[–—]/);
      expect(part.toLowerCase()).not.toContain("agency");
    }
    expect(email.bodyText).toContain("Your free trial credit is used up.");
    expect(email.bodyText).toContain("$99/month");
    const t = email.bodyText;
    expect(t.indexOf("Motivate")).toBeLessThan(t.indexOf("Bliss"));
    expect(t.indexOf("Bliss")).toBeLessThan(t.indexOf("Moving"));
  });
});
