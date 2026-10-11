/**
 * OFFER BUDGET TOTALS (dashboard v2 Today page). The per-offer campaign budgets read
 * serves, beside its items, the two totals the client is committed to right now:
 * proactive = SUM of the ON proactive budgets (spend), reactive = SUM of the ON
 * reactive ceilings (a MAX), per reaction type. Only ON campaigns count; turning
 * one off removes it; a subscriber's totals are monthly like its items; an
 * unreadable campaign status serves totals null with a reason, never 0.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { salesFunnelCaps } from "../../src/db/schema.js";
import type { SalesFunnelCampaign } from "../../src/lib/funnel-campaigns.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import {
  __primeSalesPathTerms,
  __resetSalesPathTerms,
  type PublishedSalesChannel,
} from "../../src/lib/sales-path-terms.js";

const orgId = "00000000-0000-0000-0000-0000000067a1";
const userId = "00000000-0000-0000-0000-0000000067a9";
const headers = getAuthHeaders(orgId, userId);
const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };

const BRAND = "aaaaaaaa-0067-4000-8000-000000000001";
const OFFER = "aaaaaaaa-0067-4000-8000-0000000000a1";
const COLD = "sales-cold-email-outreach";
const REPLY = "start_to_conversation";
const VISIT = "start_to_website_visit";
const MEET = "ai-meeting-booking";
const MEET_LEG = "conversation_to_meeting_booked";
const META = "meta-ads";
const TEAM = "your-team-meeting-booking";

function catalogue(metaManaged = false): PublishedSalesChannel[] {
  return [
    {
      slug: COLD,
      operatedBy: "platform",
      managed: true,
      stepTransitions: [
        { legKey: REPLY, from: null, minimumMonthlyBudgetCents: 9900 },
        { legKey: VISIT, from: null, minimumMonthlyBudgetCents: 9900 },
      ],
    },
    {
      slug: MEET,
      operatedBy: "platform",
      managed: true,
      stepTransitions: [{ legKey: MEET_LEG, from: { key: "conversation", label: "Positive reply" }, minimumMonthlyBudgetCents: 3000 }],
    },
    {
      slug: META,
      operatedBy: "platform",
      managed: metaManaged,
      stepTransitions: [{ legKey: VISIT, from: null, minimumMonthlyBudgetCents: 150000 }],
    },
    {
      slug: TEAM,
      operatedBy: "customer",
      managed: true,
      stepTransitions: [{ legKey: MEET_LEG, from: { key: "conversation" }, minimumMonthlyBudgetCents: 0 }],
    },
  ];
}

const REVOLUT_CARD = {
  object: "saved_payment_method",
  org_id: orgId,
  acquirer: "revolut",
  saved: true,
  method: { id: "rpm_1", type: "card", saved_for: "merchant" },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}


describe("offer budget totals: proactive spend + reactive ceilings, ON only", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let setUsage: (cents: string) => void;
  /** Campaigns that are ON (campaign-service status ongoing), as `featureSlug:legKey`. */
  let onCampaigns: Set<string>;
  let campaignStatusDown: boolean;
  /** campaign-service's SALES FUNNEL campaigns for the org (null = unreadable). */
  let funnelCampaigns: SalesFunnelCampaign[] | null;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    __resetSalesPathTerms();
    __primeSalesPathTerms(catalogue());
    onCampaigns = new Set([`${COLD}:${REPLY}`, `${COLD}:${VISIT}`, `${MEET}:${MEET_LEG}`, `${META}:${VISIT}`]);
    campaignStatusDown = false;
    funnelCampaigns = [];

    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@new.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");
    ssMocks.getSavedPaymentMethod.mockResolvedValue(REVOLUT_CARD);

    process.env.BRAND_SERVICE_URL = "http://brand.test";
    process.env.BRAND_SERVICE_API_KEY = "brand-key";
    const fetchRetry = await import("../../src/lib/fetch-retry.js");
    vi.spyOn(fetchRetry, "fetchWithRetry").mockImplementation(async (url: string) => {
      if (!url.startsWith("http://brand.test")) throw new Error(`unexpected fetch ${url}`);
      if (url.endsWith("/orgs/brands")) return json({ brands: [{ id: BRAND, createdAt: "2026-08-01T00:00:00Z" }] });
      if (url.endsWith(`/internal/brands/${BRAND}/offers`)) {
        return json({ offers: [{ offerId: OFFER, status: "active" }] });
      }
      return json({ offers: [] });
    });

    const cs = await import("../../src/lib/campaign-service-client.js");
    vi.spyOn(cs, "fetchRecurringCampaignStatuses").mockImplementation(async () => {
      if (campaignStatusDown) return { ok: false, reason: "campaign_service_unavailable" };
      return {
        ok: true,
        campaigns: [...onCampaigns].map((k, i) => {
          const [featureSlug, legKey] = k.split(":");
          return {
            campaignId: `00000000-0000-4000-8000-00000000000${i}`,
            orgId,
            brandId: BRAND,
            offerId: OFFER,
            legKey,
            featureSlug,
            status: "ongoing",
            running: true,
            executedByPlatform: true,
            kind: null,
            audience: "available" as const,
            allAudiencesExhausted: false,
            recurring: true,
          };
        }),
      };
    });

    const fc = await import("../../src/lib/funnel-campaigns.js");
    vi.spyOn(fc, "fetchSalesFunnelCampaigns").mockImplementation(async () =>
      funnelCampaigns === null
        ? { ok: false, reason: "campaign_service_unavailable" }
        : { ok: true, campaigns: funnelCampaigns }
    );

    const runsClient = await import("../../src/lib/runs-client.js");
    let usage = "0.0000000000";
    setUsage = (cents) => {
      usage = cents;
    };
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage,
      as_of: "2026-10-01T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage,
      as_of: "2026-10-01T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue("00000000-0000-0000-0000-00000000a001");
    vi.spyOn(runsClient, "completePlatformRun").mockResolvedValue(undefined);
    const email = await import("../../src/lib/email-client.js");
    vi.spyOn(email, "sendEmail").mockImplementation(vi.fn());
  });

  afterAll(async () => {
    __resetSalesPathTerms();
    await cleanTestData();
    await closeDb();
  });

  const itemsPath = `/v1/brands/${BRAND}/offers/${OFFER}/campaign-budgets`;

  function put(items: Array<[string, string, number]>) {
    return request(app)
      .put(itemsPath)
      .set(headers)
      .send({ items: items.map(([featureSlug, legKey, budgetCents]) => ({ featureSlug, legKey, budgetCents })) });
  }

  it("prepaid: ON proactive $X/day and ON reactive capped $Y/day -> totals $X and $Y per day", async () => {
    await insertTestAccount({ orgId });
    expect((await put([[COLD, REPLY, 1000], [MEET, MEET_LEG, 300]])).status).toBe(200);
    const res = await request(app).get(itemsPath).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.totalsUnavailableReason).toBeNull();
    expect(res.body.totals).toEqual({
      period: "day",
      proactive: { budgetCents: 1000, sourcingBudgetCents: 0, campaigns: 1 },
      reactive: {
        maxBudgetCents: 300,
        campaigns: 1,
        byTrigger: [{ triggerKey: "conversation", triggerLabel: "Positive reply", maxBudgetCents: 300, campaigns: 1 }],
      },
      notCounted: [],
      salesFunnels: [],
      salesFunnelsNotCounted: [],
    });
  });

  it("turning a campaign off removes it from its total; the internal read serves the same", async () => {
    await insertTestAccount({ orgId });
    expect((await put([[COLD, REPLY, 1000], [COLD, VISIT, 500], [MEET, MEET_LEG, 300]])).status).toBe(200);
    onCampaigns.delete(`${COLD}:${VISIT}`);
    onCampaigns.delete(`${MEET}:${MEET_LEG}`);
    const res = await request(app).get(`/internal/brands/${BRAND}/offers/${OFFER}/campaign-budgets`).set(internal);
    expect(res.status).toBe(200);
    expect(res.body.totals.proactive).toEqual({ budgetCents: 1000, sourcingBudgetCents: 0, campaigns: 1 });
    expect(res.body.totals.reactive).toEqual({ maxBudgetCents: 0, campaigns: 0, byTrigger: [] });
    // Items are unchanged: the budget of an OFF campaign is kept.
    expect(res.body.items).toHaveLength(3);
  });

  it("campaign status unreadable: totals null with a reason, items still served", async () => {
    await insertTestAccount({ orgId });
    expect((await put([[COLD, REPLY, 1000]])).status).toBe(200);
    campaignStatusDown = true;
    const res = await request(app).get(itemsPath).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.totals).toBeNull();
    expect(res.body.totalsUnavailableReason).toBe("campaign_service_unavailable");
    expect(res.body.items).toHaveLength(1);
  });

  it("an ON budget on a channel we do not run is named, never added", async () => {
    await insertTestAccount({ orgId });
    expect((await put([[COLD, REPLY, 1000], [META, VISIT, 5000]])).status).toBe(200);
    const res = await request(app).get(itemsPath).set(headers);
    expect(res.body.totals.proactive.budgetCents).toBe(1000);
    expect(res.body.totals.notCounted).toEqual([{ featureSlug: META, legKey: VISIT, reason: "channel_not_run" }]);
  });

  it("subscriber: totals are monthly, matching its items' period", async () => {
    await insertTestAccount({ orgId });
    const sub = await request(app)
      .post("/v1/accounts/subscriptions")
      .set(headers)
      .send({ brand_id: BRAND, offer_id: OFFER, monthly_amount_cents: 9900 });
    expect(sub.status).toBe(201);
    expect((await put([[COLD, REPLY, 9900], [MEET, MEET_LEG, 3000]])).status).toBe(200);
    const res = await request(app).get(itemsPath).set(headers);
    expect(res.body.period).toBe("month");
    expect(res.body.items.every((i: { period: string }) => i.period === "month")).toBe(true);
    expect(res.body.totals.period).toBe("month");
    expect(res.body.totals.proactive.budgetCents).toBe(9900);
    expect(res.body.totals.reactive.maxBudgetCents).toBe(3000);
  });

  /* ---------------- SALES FUNNEL campaigns (NOVEMIQ 2026-10-11) ---------------- */

  const BLISS = `lead_found_to_conversation@${COLD}+conversation_to_meeting_booked`;
  const MOTIVATE = `conversation_to_meeting_booked@${MEET}`;
  const MOVING = "conversation_to_booking_call@ai-instant-call";

  function funnel(id: string, salesFunnelId: string, name: string, pipes: Array<[string, string]>, status = "ongoing"): SalesFunnelCampaign {
    return {
      id,
      brandId: BRAND,
      offerId: OFFER,
      salesFunnelId,
      salesFunnelName: name,
      status,
      units: pipes.map(([featureSlug, legKey], i) => ({
        campaignId: `${id.slice(0, -1)}${i}`,
        featureSlug,
        legKey,
        status,
      })),
    };
  }

  async function cap(salesFunnelId: string, cents: number, period: string, type: string | null) {
    await db.insert(salesFunnelCaps).values({
      orgId,
      brandId: BRAND,
      offerId: OFFER,
      salesFunnelId,
      maxBudgetCents: String(cents),
      maxBudgetPeriod: period,
      maxBudgetSince: new Date(),
      salesFunnelType: type,
    });
  }

  it("funnel campaigns only (no ceiling row): counted by their caps, proactive and reactive", async () => {
    await insertTestAccount({ orgId });
    await cap(BLISS, 1000, "daily", "proactive");
    await cap(MOTIVATE, 100, "daily", "reactive");
    funnelCampaigns = [
      funnel("bbbbbbbb-0067-4000-8000-000000000010", BLISS, "Bliss", [[COLD, "lead_found_to_conversation"]]),
      funnel("bbbbbbbb-0067-4000-8000-000000000020", MOTIVATE, "Motivate", [[MEET, MEET_LEG]]),
      funnel("bbbbbbbb-0067-4000-8000-000000000030", MOVING, "Moving", [["ai-instant-call", "conversation_to_booking_call"]]),
    ];
    const res = await request(app).get(itemsPath).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.totalsUnavailableReason).toBeNull();
    expect(res.body.totals.proactive).toEqual({ budgetCents: 1000, sourcingBudgetCents: 0, campaigns: 1 });
    expect(res.body.totals.reactive).toEqual({
      maxBudgetCents: 100,
      campaigns: 1,
      byTrigger: [{ triggerKey: "conversation", triggerLabel: "Positive reply", maxBudgetCents: 100, campaigns: 1 }],
    });
    expect(res.body.totals.salesFunnels.map((f: { salesFunnelName: string; role: string; budgetCents: number }) => [f.salesFunnelName, f.role, f.budgetCents])).toEqual([
      ["Bliss", "proactive", 1000],
      ["Motivate", "reactive", 100],
    ]);
    expect(res.body.totals.salesFunnelsNotCounted).toEqual([
      { salesFunnelCampaignId: "bbbbbbbb-0067-4000-8000-000000000030", salesFunnelId: MOVING, salesFunnelName: "Moving", reason: "no_budget" },
    ]);
  });

  it("a stopped funnel campaign counts nothing; weekly / one-off caps; monthly for a subscriber-style period", async () => {
    await insertTestAccount({ orgId });
    await cap(BLISS, 7000, "weekly", "proactive");
    await cap(MOTIVATE, 5000, "one_off", "reactive");
    funnelCampaigns = [
      funnel("bbbbbbbb-0067-4000-8000-000000000010", BLISS, "Bliss", [[COLD, "lead_found_to_conversation"]]),
      funnel("bbbbbbbb-0067-4000-8000-000000000020", MOTIVATE, "Motivate", [[MEET, MEET_LEG]]),
      funnel("bbbbbbbb-0067-4000-8000-000000000030", MOVING, "Moving", [["ai-instant-call", "conversation_to_booking_call"]], "stopped"),
    ];
    const res = await request(app).get(itemsPath).set(headers);
    expect(res.body.totals.proactive.budgetCents).toBe(1000);
    expect(res.body.totals.reactive.maxBudgetCents).toBe(0);
    expect(res.body.totals.salesFunnelsNotCounted.map((f: { reason: string }) => f.reason)).toEqual(["one_off"]);
  });

  it("a ceiling left on a funnel unit's pipe is not counted beside the funnel's cap", async () => {
    await insertTestAccount({ orgId });
    expect((await put([[COLD, REPLY, 2000]])).status).toBe(200);
    await cap(BLISS, 1000, "daily", "proactive");
    funnelCampaigns = [funnel("bbbbbbbb-0067-4000-8000-000000000010", BLISS, "Bliss", [[COLD, "lead_found_to_conversation"]])];
    const res = await request(app).get(itemsPath).set(headers);
    // start_to_conversation and lead_found_to_conversation are ONE outbound leg.
    expect(res.body.totals.proactive).toEqual({ budgetCents: 1000, sourcingBudgetCents: 0, campaigns: 1 });
  });

  it("funnel campaigns unreadable: totals null with a reason, never an undercount", async () => {
    await insertTestAccount({ orgId });
    await cap(BLISS, 1000, "daily", "proactive");
    funnelCampaigns = null;
    const res = await request(app).get(itemsPath).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.totals).toBeNull();
    expect(res.body.totalsUnavailableReason).toBe("campaign_service_unavailable");
  });
});
