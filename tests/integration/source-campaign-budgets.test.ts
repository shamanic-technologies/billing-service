/**
 * SOURCE CAMPAIGNS (owner 2026-10-07, features-service v0.179.79): a lead source is
 * a campaign of its own, keyed (offer, featureSlug = <origin slug>, legKey =
 * "start_to_lead_found"), budgeted like any campaign on the per-offer items route.
 * Its budget is the sourcing money the outreach campaign used to carry as a split
 * (migrations 0074 + 0075); migration 0076 moves it, offer totals unchanged.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { readFileSync } from "fs";
import postgres from "postgres";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaignDailyBudgets } from "../../src/db/schema.js";
import {
  __primeSalesPathTerms,
  __resetSalesPathTerms,
  getSalesPathTerms,
  type PublishedSalesChannel,
  type PublishedSourcingOrigins,
} from "../../src/lib/sales-path-terms.js";

const orgId = "00000000-0000-0000-0000-0000000076a1";
const userId = "00000000-0000-0000-0000-0000000076a9";
const headers = getAuthHeaders(orgId, userId);
const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };

const BRAND = "aaaaaaaa-0076-4000-8000-000000000001";
const OFFER = "aaaaaaaa-0076-4000-8000-0000000000a1";
const COLD = "sales-cold-email-outreach";
const CRM = "sales-crm-email-outreach";
const REPLY = "start_to_conversation";
const MEET = "ai-meeting-booking";
const MEET_LEG = "conversation_to_meeting_booked";
const APOLLO = "sourcing-apollo-cold-filters";
const CRM_SOURCE = "sourcing-crm-contacts";
const SOURCE_LEG = "start_to_lead_found";

const CHANNELS: PublishedSalesChannel[] = [
  {
    slug: COLD,
    operatedBy: "platform",
    managed: true,
    stepTransitions: [{ legKey: REPLY, from: null, minimumMonthlyBudgetCents: 9900 }],
  },
  {
    slug: CRM,
    operatedBy: "platform",
    managed: true,
    stepTransitions: [{ legKey: REPLY, from: null, minimumMonthlyBudgetCents: 9900 }],
  },
  {
    slug: MEET,
    operatedBy: "platform",
    managed: true,
    stepTransitions: [{ legKey: MEET_LEG, from: { key: "conversation" }, minimumMonthlyBudgetCents: 0 }],
  },
];

/** `GET /public/sourcing-origins` as features-service serves it (prod 2026-10-07, trimmed). */
const ORIGINS: PublishedSourcingOrigins = {
  origins: [
    { slug: APOLLO, live: true },
    { slug: "sourcing-apollo-buying-signals", live: true },
    { slug: "sourcing-linkedin-engagement-signals", live: true },
    { slug: CRM_SOURCE, live: true },
    { slug: "sourcing-apify-search", live: false },
  ],
  sourceLegKey: SOURCE_LEG,
  originsByChannel: {
    [COLD]: [APOLLO, "sourcing-apollo-buying-signals", "sourcing-linkedin-engagement-signals", "sourcing-apify-search"],
    "feedback-request-cold-email-outreach": [APOLLO],
    [CRM]: [CRM_SOURCE],
  },
};

const app = createTestApp();
const itemsPath = `/v1/brands/${BRAND}/offers/${OFFER}/campaign-budgets`;

function putItems(items: Array<{ featureSlug: string; legKey: string; budgetCents: number }>) {
  return request(app).put(itemsPath).set(headers).send({ items });
}

async function seed(featureSlug: string, legKey: string | null, daily: string, sourcing: string | null, offerId: string | null = OFFER) {
  await db.insert(campaignDailyBudgets).values({
    orgId,
    brandId: BRAND,
    featureSlug,
    offerId,
    legKey,
    dailyBudgetCents: daily,
    sourcingCeilingCents: sourcing,
    updatedAt: new Date(),
  });
}

describe("source campaign budgets", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    await insertTestAccount({ orgId, paymentMode: "prepaid" });
    __resetSalesPathTerms();
    __primeSalesPathTerms(CHANNELS, ORIGINS);
  });
  afterAll(async () => {
    __resetSalesPathTerms();
    await cleanTestData();
    await closeDb();
  });

  it("a source campaign's budget is set and read on the per-offer items route, like any campaign", async () => {
    await seed(COLD, REPLY, "6500", null);
    const res = await putItems([{ featureSlug: APOLLO, legKey: SOURCE_LEG, budgetCents: 4200 }]);
    expect(res.status).toBe(200);
    const source = res.body.items.find((i: { featureSlug: string }) => i.featureSlug === APOLLO);
    expect(source).toMatchObject({
      legKey: SOURCE_LEG,
      role: "proactive",
      source: true,
      period: "day",
      budgetCents: 4200,
      dailyBudgetCents: "4200.0000000000",
      outreachDailyBudgetCents: "4200.0000000000",
      sourcingCeilingCents: null,
      split: false,
      managed: true,
      minimumCents: 0,
      budgetable: true,
    });
    const outreach = res.body.items.find((i: { featureSlug: string }) => i.featureSlug === COLD);
    expect(outreach).toMatchObject({ source: false, dailyBudgetCents: "6500.0000000000", split: false });

    // The offer total is the sum of both campaigns; the brand total too.
    const offer = await request(app).get(`/internal/brands/${BRAND}/offers/${OFFER}/daily-budget`).set(internal);
    expect(offer.status).toBe(200);
    expect(offer.body.dailyBudgetCents).toBe("10700.0000000000");
    const brand = await request(app).get(`/internal/brands/${BRAND}/daily-budget`).set(internal);
    expect(brand.body.dailyBudgetCents).toBe("10700.0000000000");

    // A "not set" source row is served on request, and DELETE puts it back there.
    const del = await request(app)
      .delete(itemsPath)
      .query({ featureSlug: APOLLO, legKey: SOURCE_LEG })
      .set(headers);
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(true);
    const read = await request(app)
      .get(itemsPath)
      .query({ campaigns: `${APOLLO}:${SOURCE_LEG}` })
      .set(headers);
    expect(read.body.items.find((i: { featureSlug: string }) => i.featureSlug === APOLLO)).toMatchObject({
      budgetCents: null,
      source: true,
      minimumCents: 0,
    });
  });

  it("a retired origin takes no new budget", async () => {
    const res = await putItems([{ featureSlug: "sourcing-apify-search", legKey: SOURCE_LEG, budgetCents: 500 }]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("unknown_item");
  });

  it("a source campaign alone is not the entry a follow-up campaign needs", async () => {
    const res = await putItems([
      { featureSlug: APOLLO, legKey: SOURCE_LEG, budgetCents: 4200 },
      { featureSlug: MEET, legKey: MEET_LEG, budgetCents: 500 },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("entry_item_required");
  });

  it("the brand-wide ceilings list carries the source campaign beside the outreach one", async () => {
    await seed(COLD, REPLY, "6500", null);
    await seed(APOLLO, SOURCE_LEG, "4200", null);
    const res = await request(app).get(`/internal/brands/${BRAND}/campaign-budgets`).set(internal);
    expect(res.status).toBe(200);
    expect(res.body.dailyBudgetCents).toBe("10700.0000000000");
    const slugs = res.body.campaigns.map((c: { featureSlug: string }) => c.featureSlug).sort();
    expect(slugs).toEqual([COLD, APOLLO].sort());
  });

  it("an outreach campaign whose offer funds its source campaign takes no sourcing ceiling (409); a plain total still writes", async () => {
    await seed(COLD, REPLY, "6500", null);
    await seed(APOLLO, SOURCE_LEG, "4200", null);
    const key = { offerId: OFFER, legKey: REPLY, featureSlug: COLD };
    const split = await request(app)
      .put(`/v1/brands/${BRAND}/campaign-budget`)
      .set(headers)
      .send({ ...key, dailyBudgetCents: 10000, sourcingCeilingCents: 3000 });
    expect(split.status).toBe(409);
    expect(split.body).toMatchObject({ code: "sourcing_has_its_own_campaign", sourceFeatureSlugs: [APOLLO] });
    const plain = await request(app)
      .put(`/v1/brands/${BRAND}/campaign-budget`)
      .set(headers)
      .send({ ...key, dailyBudgetCents: 7000 });
    expect(plain.status).toBe(200);
    expect(plain.body).toMatchObject({ dailyBudgetCents: "7000.0000000000", sourcingCeilingCents: null });
  });

  it("a source campaign that does not feed the channel does not block its split", async () => {
    await seed(COLD, REPLY, "6500", null);
    await seed(CRM_SOURCE, SOURCE_LEG, "1000", null);
    const res = await request(app)
      .put(`/v1/brands/${BRAND}/campaign-budget`)
      .set(headers)
      .send({ offerId: OFFER, legKey: REPLY, featureSlug: COLD, dailyBudgetCents: 6500, sourcingCeilingCents: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.sourcingCeilingCents).toBe("1000.0000000000");
  });

  it("the terms read needs the origins catalogue too: unreadable = minimums_unavailable, nothing saved", async () => {
    __resetSalesPathTerms();
    process.env.FEATURES_SERVICE_URL = "http://features.test";
    const fetchRetry = await import("../../src/lib/fetch-retry.js");
    vi.spyOn(fetchRetry, "fetchWithRetry").mockImplementation(async (url: string) => {
      if (url.endsWith("/public/channels")) return Response.json({ channels: CHANNELS });
      return new Response("down", { status: 503 });
    });
    await expect(getSalesPathTerms()).rejects.toThrow(/sourcing origins/);
    const res = await putItems([{ featureSlug: APOLLO, legKey: SOURCE_LEG, budgetCents: 4200 }]);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("minimums_unavailable");
    expect(await db.select().from(campaignDailyBudgets)).toHaveLength(0);
  });

  it("migration 0076 moves each offer's sourcing part onto its source campaign, totals unchanged, re-apply moves nothing", async () => {
    const OFFER2 = "aaaaaaaa-0076-4000-8000-0000000000a2";
    const OFFER3 = "aaaaaaaa-0076-4000-8000-0000000000a3";
    // The prod Jubilation row (org 91e76989): $107/day, sourcing up to $42.
    await seed(COLD, REPLY, "10700", "4200");
    // Two outreach legs of one offer fed by one origin add up on ONE source row.
    await seed(COLD, REPLY, "2000", "1200", OFFER2);
    await seed(COLD, "start_to_website_visit", "1000", "500", OFFER2);
    // A leg-less offer row moves too (the source is keyed on the offer).
    await seed("feedback-request-cold-email-outreach", null, "4900", "3200", OFFER3);
    // CRM email -> Your CRM Contacts.
    await seed(CRM, REPLY, "300", "100", OFFER3);
    // Untouched: an offer-less legacy row, an unsplit row, a reactive $0 split.
    await seed(COLD, REPLY, "800", "300", null);
    await seed(MEET, MEET_LEG, "2000", "0", OFFER);
    await seed(COLD, "start_to_website_visit", "900", null, OFFER);

    const sumByOffer = async () => {
      const rows = await db.select().from(campaignDailyBudgets);
      const out: Record<string, number> = {};
      for (const r of rows) out[r.offerId ?? "none"] = (out[r.offerId ?? "none"] ?? 0) + Number(r.dailyBudgetCents);
      return out;
    };
    const before = await sumByOffer();

    const migration = readFileSync(new URL("../../drizzle/0076_source_campaign_budgets.sql", import.meta.url), "utf8");
    const sql = postgres(process.env.BILLING_SERVICE_DATABASE_URL || "postgresql://test:test@localhost/test", { max: 1 });
    try {
      for (let pass = 0; pass < 2; pass++) await sql.unsafe(migration);
    } finally {
      await sql.end();
    }

    expect(await sumByOffer()).toEqual(before);
    const rows = await db.select().from(campaignDailyBudgets);
    const find = (slug: string, offer: string | null, leg: string | null) =>
      rows.find((r) => r.featureSlug === slug && r.offerId === offer && r.legKey === leg);

    expect(find(COLD, OFFER, REPLY)).toMatchObject({ dailyBudgetCents: "6500.0000000000", sourcingCeilingCents: null });
    expect(find(APOLLO, OFFER, SOURCE_LEG)).toMatchObject({ dailyBudgetCents: "4200.0000000000", sourcingCeilingCents: null });
    expect(find(COLD, OFFER2, REPLY)!.dailyBudgetCents).toBe("800.0000000000");
    expect(find(COLD, OFFER2, "start_to_website_visit")!.dailyBudgetCents).toBe("500.0000000000");
    expect(find(APOLLO, OFFER2, SOURCE_LEG)!.dailyBudgetCents).toBe("1700.0000000000");
    expect(find("feedback-request-cold-email-outreach", OFFER3, null)!.dailyBudgetCents).toBe("1700.0000000000");
    expect(find(APOLLO, OFFER3, SOURCE_LEG)!.dailyBudgetCents).toBe("3200.0000000000");
    expect(find(CRM, OFFER3, REPLY)!.dailyBudgetCents).toBe("200.0000000000");
    expect(find(CRM_SOURCE, OFFER3, SOURCE_LEG)!.dailyBudgetCents).toBe("100.0000000000");
    // Untouched rows.
    expect(find(COLD, null, REPLY)).toMatchObject({ dailyBudgetCents: "800.0000000000", sourcingCeilingCents: "300.0000000000" });
    expect(find(MEET, OFFER, MEET_LEG)).toMatchObject({ sourcingCeilingCents: "0.0000000000" });
    expect(find(COLD, OFFER, "start_to_website_visit")).toMatchObject({ dailyBudgetCents: "900.0000000000" });
    // Four source rows were opened (OFFER, OFFER2, OFFER3 x Apollo + CRM).
    expect(rows.filter((r) => r.legKey === SOURCE_LEG)).toHaveLength(4);
  });
});
