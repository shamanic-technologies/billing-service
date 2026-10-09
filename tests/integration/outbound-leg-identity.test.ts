/**
 * The outbound leg-key rename (owner 2026-10-09, lib/leg-identity).
 * Every route taking a leg key answers the same for the legacy and the new
 * spelling of an OUTBOUND leg, a write under one spelling never opens a second
 * budget beside the other, and (wave 2) what is written and served is the new
 * spelling, a not-yet-migrated legacy row included.
 * A non-outbound start_to_website_visit is unaffected.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaignDailyBudgets } from "../../src/db/schema.js";
import {
  __primeSalesPathTerms,
  __resetSalesPathTerms,
} from "../../src/lib/sales-path-terms.js";

const orgId = "00000000-0000-0000-0000-0000000079a1";
const userId = "00000000-0000-0000-0000-0000000079a9";
const headers = getAuthHeaders(orgId, userId);
const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };

const BRAND = "aaaaaaaa-0079-4000-8000-000000000001";
const OFFER = "aaaaaaaa-0079-4000-8000-0000000000a1";
const COLD = "sales-cold-email-outreach";
const META = "meta-ads";
const LEGACY_REPLY = "start_to_conversation";
const NEW_REPLY = "lead_found_to_conversation";
const LEGACY_VISIT = "start_to_website_visit";
const NEW_VISIT = "lead_found_to_website_visit";

const app = createTestApp();

async function seed(featureSlug: string, legKey: string, cents: string) {
  await db.insert(campaignDailyBudgets).values({
    orgId,
    brandId: BRAND,
    featureSlug,
    offerId: OFFER,
    legKey,
    dailyBudgetCents: cents,
    updatedAt: new Date(),
  });
}

async function rows() {
  return (await db.select().from(campaignDailyBudgets)).filter((r) => r.brandId === BRAND);
}

function readCampaign(legKey: string, featureSlug = COLD) {
  return request(app)
    .get(`/internal/brands/${BRAND}/campaign-budget`)
    .query({ offerId: OFFER, legKey, featureSlug })
    .set(internal);
}

function strip(body: Record<string, unknown>) {
  // The echo of the asked leg is the caller's own input; everything else must match.
  const { legKey: _legKey, ...rest } = body;
  return rest;
}

describe("outbound leg keys: legacy and new spelling are one identity", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    __resetSalesPathTerms();
    __primeSalesPathTerms([
      {
        slug: COLD,
        operatedBy: "platform",
        managed: true,
        stepTransitions: [
          { legKey: LEGACY_REPLY, from: null, reactive: false, minimumMonthlyBudgetCents: 9900 },
          { legKey: LEGACY_VISIT, from: null, reactive: false, minimumMonthlyBudgetCents: 9900 },
        ],
      },
      {
        slug: META,
        operatedBy: "platform",
        managed: false,
        stepTransitions: [{ legKey: LEGACY_VISIT, from: null, reactive: false, minimumMonthlyBudgetCents: 150000 }],
      },
    ]);
    const cs = await import("../../src/lib/campaign-service-client.js");
    vi.spyOn(cs, "fetchRecurringCampaignStatuses").mockResolvedValue({ ok: true, campaigns: [] });
    const email = await import("../../src/lib/email-client.js");
    vi.spyOn(email, "sendEmail").mockImplementation(vi.fn());
  });

  afterAll(async () => {
    __resetSalesPathTerms();
    await cleanTestData();
    await closeDb();
  });

  it("the per-campaign read answers the same under both spellings; a non-outbound leg does not", async () => {
    await seed(COLD, LEGACY_REPLY, "500.0000000000");
    await seed(META, LEGACY_VISIT, "900.0000000000");

    const legacy = await readCampaign(LEGACY_REPLY);
    const renamed = await readCampaign(NEW_REPLY);
    expect(legacy.status).toBe(200);
    expect(legacy.body.dailyBudgetCents).toBe("500.0000000000");
    expect(strip(renamed.body)).toEqual(strip(legacy.body));

    expect((await readCampaign(LEGACY_VISIT, META)).body.dailyBudgetCents).toBe("900.0000000000");
    expect((await readCampaign(NEW_VISIT, META)).body.dailyBudgetCents).toBeNull();
  });

  it("the per-leg read counts the outbound row under both spellings", async () => {
    await seed(COLD, LEGACY_VISIT, "500.0000000000");
    await seed(META, LEGACY_VISIT, "900.0000000000");
    const legacy = await request(app).get(`/internal/brands/${BRAND}/legs/${LEGACY_VISIT}/daily-budget`).set(internal);
    const renamed = await request(app).get(`/internal/brands/${BRAND}/legs/${NEW_VISIT}/daily-budget`).set(internal);
    expect(legacy.body.dailyBudgetCents).toBe("1400.0000000000");
    // The new spelling names the outbound leg only: the ads row keeps its own key.
    expect(renamed.body.dailyBudgetCents).toBe("500.0000000000");
    expect(renamed.body.campaigns.map((c: { legKey: string }) => c.legKey)).toEqual([LEGACY_VISIT]);
  });

  it("a ceiling write under the new spelling updates the legacy row in place (one row, new spelling)", async () => {
    await seed(COLD, LEGACY_REPLY, "500.0000000000");
    const res = await request(app)
      .put(`/v1/brands/${BRAND}/campaign-budget`)
      .set(headers)
      .send({ offerId: OFFER, legKey: NEW_REPLY, featureSlug: COLD, dailyBudgetCents: 700 });
    expect(res.status).toBe(200);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ legKey: NEW_REPLY, dailyBudgetCents: "700.0000000000" });
    expect(res.body.legKey).toBe(NEW_REPLY);
    expect((await readCampaign(LEGACY_REPLY)).body.dailyBudgetCents).toBe("700.0000000000");
  });

  it("item budgets: read, write and delete under the new spelling act on the legacy row", async () => {
    await insertTestAccount({ orgId });
    await seed(COLD, LEGACY_REPLY, "500.0000000000");
    const itemsPath = `/v1/brands/${BRAND}/offers/${OFFER}/campaign-budgets`;

    const legacyView = await request(app).get(`${itemsPath}?campaigns=${COLD}:${LEGACY_REPLY}`).set(headers);
    const newView = await request(app).get(`${itemsPath}?campaigns=${COLD}:${NEW_REPLY}`).set(headers);
    expect(newView.status).toBe(200);
    expect(newView.body.items).toEqual(legacyView.body.items);
    expect(newView.body.items).toHaveLength(1);
    expect(newView.body.items[0]).toMatchObject({ legKey: LEGACY_REPLY, budgetCents: 500, minimumCents: 330 });
    // A "not set" pair asked under the legacy spelling is served under the new one.
    const notSet = await request(app).get(`${itemsPath}?campaigns=${COLD}:${LEGACY_VISIT}`).set(headers);
    expect(notSet.body.items.map((i: { legKey: string }) => i.legKey)).toEqual([LEGACY_REPLY, NEW_VISIT]);

    // Both spellings in one write are one campaign listed twice.
    const dup = await request(app)
      .put(itemsPath)
      .set(headers)
      .send({ items: [{ featureSlug: COLD, legKey: LEGACY_REPLY, budgetCents: 600 }, { featureSlug: COLD, legKey: NEW_REPLY, budgetCents: 600 }] });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe("duplicate_item");

    const write = await request(app)
      .put(itemsPath)
      .set(headers)
      .send({ items: [{ featureSlug: COLD, legKey: NEW_REPLY, budgetCents: 800 }] });
    expect(write.status).toBe(200);
    let stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ legKey: NEW_REPLY, dailyBudgetCents: "800.0000000000" });

    const del = await request(app).delete(`${itemsPath}?featureSlug=${COLD}&legKey=${NEW_REPLY}`).set(headers);
    expect(del.status).toBe(200);
    stored = await rows();
    expect(stored).toHaveLength(0);
  });

  it("a row stored under the NEW spelling (wave 2) is found by a legacy-key caller", async () => {
    await seed(COLD, NEW_REPLY, "300.0000000000");
    const legacy = await readCampaign(LEGACY_REPLY);
    expect(legacy.body.dailyBudgetCents).toBe("300.0000000000");
    // The legacy-spelled request is answered under the new spelling.
    expect(legacy.body.legKey).toBe(NEW_REPLY);
    const res = await request(app)
      .put(`/v1/brands/${BRAND}/campaign-budget`)
      .set(headers)
      .send({ offerId: OFFER, legKey: LEGACY_REPLY, featureSlug: COLD, dailyBudgetCents: 400 });
    expect(res.status).toBe(200);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ legKey: NEW_REPLY, dailyBudgetCents: "400.0000000000" });
  });
});
