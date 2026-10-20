/**
 * The MONTHLY LIMIT on a subscription (lib/monthly-charge-limit), inverted by the
 * owner 2026-10-21: it caps SPEND at authorize and NEVER refuses a charge. So a
 * plan step or a renewal is charged even when this month's card charges already
 * passed the limit; once the limit has refused a spend this month, a credit
 * shortfall does NOT buy a plan step (credit the org could not spend this month),
 * and the customer gets the ONE limit email, never the out-of-credits one.
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
import { setMonthlyChargeLimit, recordMonthlyLimitRefusal, MONTHLY_CHARGE_LIMIT_REACHED_EVENT } from "../../src/lib/monthly-charge-limit.js";
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

  it("charges are never refused by the limit: step and renewal go through past it", async () => {
    const start = new Date(Date.now() - DAY * 1.5);
    const sub = await startTrial(start);
    await setMonthlyChargeLimit(orgId, 5000, userId);

    usage = "9900.0000000000";
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("upgraded");
    const upgraded = (await getLiveSubscription(orgId))!;
    usage = "19900.0000000000";
    const afterTrial = await advanceSubscription(upgraded, new Date(sub.trialEndsAt!.getTime() + 1000));
    expect(afterTrial.status).toBe("active");
    expect(charges.map((c) => c.amount)).toEqual([10000, 19900]);
  });

  it("once the limit refused a spend this month, no plan step is bought; raising the limit re-opens it", async () => {
    const start = new Date(Date.now() - DAY * 1.5);
    await startTrial(start);
    await setMonthlyChargeLimit(orgId, 3000, userId);
    await recordMonthlyLimitRefusal({ orgId, amountCents: 20, limitCents: 3000, chargedCents: 2990 });

    usage = "9900.0000000000";
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("monthly_limit_reached");
    expect(charges).toEqual([]);
    expect(await db.select().from(subscriptionAutoUpgrades).where(eq(subscriptionAutoUpgrades.orgId, orgId))).toHaveLength(0);
    await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(1));
    expect(sendSpy.mock.calls[0][0].eventType).toBe(MONTHLY_CHARGE_LIMIT_REACHED_EVENT);

    await setMonthlyChargeLimit(orgId, 39900, userId);
    expect(await notifySubscriptionOutOfCreditsIfDue(orgId)).toBe("upgraded");
    expect(charges.map((c) => c.amount)).toEqual([10000]);
  });
});
