/**
 * A max volume is never stated alone (owner 2026-11-24, VOL-NEEDS-USD-1124:
 * « Option B -> ajoute aussi un max en $ »). Threads Posts held only « 1 new
 * person a day », billing could not count it, and its sourcing spent $8.12 in a
 * morning. A caps PUT stating a max volume with no max budget is refused, and a
 * volume-only row stored before the rule reads NOT funded.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { salesFunnelCapChanges, salesFunnelCaps } from "../../src/db/schema.js";
import * as catalogue from "../../src/lib/sales-funnel-catalogue.js";
import type { SalesFunnel } from "../../src/lib/sales-funnel-catalogue.js";
import { __primeSalesPathTerms, __resetSalesPathTerms } from "../../src/lib/sales-path-terms.js";

const orgId = "00000000-0000-4000-8000-000001124a01";
const userId = "00000000-0000-4000-8000-000001124a09";
const runId = "00000000-0000-4000-8000-000001124a0b";
const brandId = "00000000-0000-4000-8000-000001124b01";
const OFFER = "aaaaaaaa-1124-4124-8124-aaaaaaaaaaaa";
const FUNNEL = "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client";
const FUNNEL_CAMPAIGN = "cccccccc-1124-4124-8124-cccccccccccc";

const SALES_FUNNEL: SalesFunnel = {
  id: FUNNEL,
  name: "Cold Email",
  type: "proactive",
  triggerSlug: null,
  triggerName: null,
  pipes: [
    {
      pipeId: "sales-cold-email-outreach|lead_found_to_conversation",
      channelSlug: "sales-cold-email-outreach",
      legKey: "lead_found_to_conversation",
      strategyId: null,
      mode: "proactive",
      toStep: "email_sent",
    },
  ],
};

const app = createTestApp();
const auth = getAuthHeaders(orgId, userId, runId);
const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const funnelPath = `/brands/${brandId}/offers/${OFFER}/sales-funnels/${encodeURIComponent(FUNNEL)}/caps`;
const campaignPath = `/brands/${brandId}/offers/${OFFER}/sales-funnels/${encodeURIComponent(FUNNEL)}/campaigns/${FUNNEL_CAMPAIGN}/caps`;

const VOLUME_ONLY = { maxBudget: null, maxVolume: { count: 1, period: "daily" } };
const BUDGET_ONLY = { maxBudget: { amountCents: 500, period: "daily" }, maxVolume: null };
const BOTH = { maxBudget: { amountCents: 500, period: "daily" }, maxVolume: { count: 1, period: "daily" } };

const read = (path = funnelPath) => request(app).get(`/internal${path}`).set(internal);

describe("sales funnel caps: a max volume needs a max budget beside it", () => {
  beforeEach(async () => {
    await cleanTestData();
    __primeSalesPathTerms([], { sourceLegKey: "start_to_lead_found", origins: [], originsByChannel: {} } as never);
    vi.spyOn(catalogue, "getSalesFunnel").mockResolvedValue(SALES_FUNNEL);
    // What the funnel consumed is not this file's subject: every measurement read is down,
    // the caps are still served (consumed null + a reason).
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetSalesPathTerms();
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  const refusedAndNothingStored = async (res: request.Response) => {
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("max_budget_required_with_max_volume");
    expect(await db.select().from(salesFunnelCaps)).toHaveLength(0);
    expect(await db.select().from(salesFunnelCapChanges)).toHaveLength(0);
  };

  it("PUT /v1 with a max volume and no max budget: 400, nothing stored", async () => {
    await refusedAndNothingStored(await request(app).put(`/v1${funnelPath}`).set(auth).send(VOLUME_ONLY));
    expect((await read()).body).toMatchObject({ stated: false, funded: false, fundedBy: null });
  });

  it("PUT /internal (campaign-service) with a max volume and no max budget: 400, nothing stored", async () => {
    await refusedAndNothingStored(await request(app).put(`/internal${funnelPath}`).set(internal).send(VOLUME_ONLY));
  });

  it("one funnel campaign's own cap follows the same rule on both routes", async () => {
    await refusedAndNothingStored(await request(app).put(`/v1${campaignPath}`).set(auth).send(VOLUME_ONLY));
    await refusedAndNothingStored(await request(app).put(`/internal${campaignPath}`).set(internal).send(VOLUME_ONLY));
  });

  it("a volume-only PUT never strips the max budget of a cap already stated", async () => {
    expect((await request(app).put(`/v1${funnelPath}`).set(auth).send(BOTH)).status).toBe(200);
    const res = await request(app).put(`/v1${funnelPath}`).set(auth).send(VOLUME_ONLY);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("max_budget_required_with_max_volume");
    const [row] = await db.select().from(salesFunnelCaps);
    expect(row.maxBudgetCents).toBe("500.0000000000");
    expect(row.maxVolume).toBe(1);
    expect((await read()).body).toMatchObject({ funded: true, fundedBy: "both" });
  });

  it("a max budget alone stays valid: 200, funded by max_budget", async () => {
    for (const prefix of ["/v1", "/internal"] as const) {
      const res = await request(app).put(`${prefix}${funnelPath}`).set(prefix === "/v1" ? auth : internal).send(BUDGET_ONLY);
      expect(res.status).toBe(200);
      expect((await read()).body).toMatchObject({ stated: true, funded: true, fundedBy: "max_budget", maxVolume: null });
    }
  });

  it("a max budget with a max volume: 200, funded by both", async () => {
    for (const prefix of ["/v1", "/internal"] as const) {
      const res = await request(app).put(`${prefix}${funnelPath}`).set(prefix === "/v1" ? auth : internal).send(BOTH);
      expect(res.status).toBe(200);
      const body = (await read()).body;
      expect(body).toMatchObject({ stated: true, funded: true, fundedBy: "both" });
      expect(body.maxBudget.amountCents).toBe("500.0000000000");
      expect(body.maxVolume.count).toBe(1);
    }
  });

  it("a volume-only row stored before the rule reads NOT funded, on the caps read and the brand list", async () => {
    await db.insert(salesFunnelCaps).values({
      orgId, brandId, offerId: OFFER, salesFunnelId: FUNNEL,
      maxVolume: 1, maxVolumePeriod: "daily", maxVolumeSince: new Date(),
    });
    const body = (await read()).body;
    expect(body).toMatchObject({ stated: true, funded: false, fundedBy: null, maxBudget: null });
    expect(body.maxVolume.count).toBe(1);

    const list = await request(app).get(`/internal/brands/${brandId}/sales-funnel-caps`).set(internal);
    expect(list.status).toBe(200);
    expect(list.body.caps).toHaveLength(1);
    expect(list.body.caps[0]).toMatchObject({ salesFunnelId: FUNNEL, funded: false, fundedBy: null, maxBudget: null });
  });
});
