/**
 * CLIENT-ACTIVITY-1030: a customer's budget change is reported to crm-service
 * (`POST /internal/account-activity`), which files the Unibox line and sends the
 * owner ONE Telegram. Billing sends no budget Telegram of its own any more.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { __resetSalesFunnelCache } from "../../src/lib/sales-funnel-catalogue.js";
import { __primeSalesPathTerms, __resetSalesPathTerms } from "../../src/lib/sales-path-terms.js";
import * as telegram from "../../src/lib/telegram-client.js";
import { budgetChangeLines } from "../../src/lib/account-activity.js";

const orgId = "00000000-0000-0000-0000-00000000c1a1";
const userId = "6f1c2a3b-4d5e-4f60-8a7b-1c2d3e4f5a6b";
const brandId = "00000000-0000-0000-0000-00000000c1b1";
const OFFER = "aaaaaaaa-1030-4030-8030-aaaaaaaaaaaa";
const FUNNEL = "signup_to_paid_client@ai-follow-up-email";
const FC = "cccccccc-1030-4030-8030-00000000000a";

const app = createTestApp();
const person = {
  "X-API-Key": "test-api-key",
  "x-org-id": orgId,
  "x-user-id": userId,
  "x-run-id": "00000000-0000-0000-0000-000000000aaa",
  "x-email": "founder@client.test",
  "Content-Type": "application/json",
};
const service = { "X-API-Key": "test-api-key", "x-org-id": orgId, "Content-Type": "application/json" };
const funnelPath = `/brands/${brandId}/offers/${OFFER}/sales-funnels/${encodeURIComponent(FUNNEL)}/caps`;
const campaignPath = `/brands/${brandId}/offers/${OFFER}/sales-funnels/${encodeURIComponent(FUNNEL)}/campaigns/${FC}/caps`;

const settle = () => new Promise((r) => setTimeout(r, 60));

interface CrmCall {
  headers: Record<string, string>;
  body: Record<string, any>;
}

let crm: CrmCall[] = [];
let crmAnswer: () => Promise<Response> = async () => Response.json({ id: "x", stored: true, duplicate: false });

function mockUpstreams() {
  crm = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/internal/account-activity") {
      crm.push({ headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
      return crmAnswer();
    }
    if (url.pathname.startsWith("/internal/catalogue/sales-funnels/")) {
      return Response.json({
        object: "sales_funnel",
        id: FUNNEL,
        name: "Follow-up",
        type: "reactive",
        legs: [{ legKey: "signup_to_paid_client", pipe: { id: `ai-follow-up-email|signup_to_paid_client`, mode: "reactive" } }],
      });
    }
    if (url.pathname === "/sales-funnel-campaigns") {
      return Response.json({
        salesFunnelCampaigns: [
          { id: FC, brandId, offerId: OFFER, salesFunnelId: FUNNEL, salesFunnelName: "Follow-up", name: "ABA Owners Meetings", status: "ongoing", units: [] },
        ],
      });
    }
    if (url.pathname === "/internal/campaigns/recurring-status") return Response.json({ campaigns: [] });
    return new Response("not mocked", { status: 404 });
  });
}

describe("budget changes reported to crm-service", () => {
  const saved = { ...process.env };
  let tg: ReturnType<typeof vi.spyOn>;
  beforeAll(() => {
    process.env.FEATURES_SERVICE_API_KEY = "k";
    process.env.CAMPAIGN_SERVICE_URL = "http://campaign.test";
    process.env.CAMPAIGN_SERVICE_API_KEY = "k";
    process.env.CRM_SERVICE_URL = "http://crm.test";
    process.env.CRM_SERVICE_API_KEY = "crm-key";
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_OWNER_CHAT_ID = "42";
  });
  beforeEach(async () => {
    await cleanTestData();
    __resetSalesFunnelCache();
    __primeSalesPathTerms([], { sourceLegKey: "start_to_lead_found", origins: [], originsByChannel: {} } as never);
    crmAnswer = async () => Response.json({ id: "x", stored: true, duplicate: false });
    mockUpstreams();
    tg = vi.spyOn(telegram, "sendOwnerTelegram").mockResolvedValue({ ok: true, messageId: 1 });
    const email = await import("../../src/lib/email-client.js");
    vi.spyOn(email, "sendEmail").mockImplementation(vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetSalesPathTerms();
  });
  afterAll(async () => {
    process.env = saved;
    await cleanTestData();
    await closeDb();
  });

  it("set, change, re-save, remove a funnel campaign's caps: one report per real change, before and after, actor forwarded", async () => {
    const put = (body: object) => request(app).put(`/v1${campaignPath}`).set(person).send(body);
    expect((await put({ maxBudget: { amountCents: 2000, period: "daily" }, maxVolume: null })).status).toBe(200);
    expect((await put({ maxBudget: { amountCents: 5000, period: "daily" }, maxVolume: { count: 10, period: "weekly" } })).status).toBe(200);
    expect((await put({ maxBudget: { amountCents: "5000", period: "daily" }, maxVolume: { count: 10, period: "weekly" } })).status).toBe(200);
    expect((await request(app).delete(`/v1${campaignPath}`).set(person)).status).toBe(200);
    expect((await request(app).delete(`/v1${campaignPath}`).set(person)).status).toBe(200);
    await settle();

    expect(crm).toHaveLength(3);
    for (const c of crm) {
      expect(c.headers["x-api-key"]).toBe("crm-key");
      expect(c.headers["x-org-id"]).toBe(orgId);
      expect(c.headers["x-user-id"]).toBe(userId);
      expect(c.headers["x-email"]).toBe("founder@client.test");
      expect(c.body).toMatchObject({
        producer: "billing-service",
        type: "campaign_budget_changed",
        title: "Budget changed",
        brandId,
        subject: { kind: "campaign", id: FC, name: "ABA Owners Meetings" },
      });
      expect(JSON.stringify(c.body)).not.toMatch(/[–—]/);
    }
    expect(crm[0].body.changes).toEqual([{ label: "Max budget", before: "none", after: "$20/day" }]);
    expect(crm[1].body.changes).toEqual([
      { label: "Max budget", before: "$20/day", after: "$50/day" },
      { label: "Max volume", before: "none", after: "10/week" },
    ]);
    expect(crm[2].body.changes).toEqual([
      { label: "Max budget", before: "$50/day", after: "none" },
      { label: "Max volume", before: "10/week", after: "none" },
    ]);
    expect(new Set(crm.map((c) => c.body.activityId)).size).toBe(3);
  });

  it("a funnel-wide cap names the sales funnel", async () => {
    await request(app).put(`/v1${funnelPath}`).set(person).send({ maxBudget: { amountCents: 1050, period: "monthly" }, maxVolume: null });
    await settle();
    expect(crm).toHaveLength(1);
    expect(crm[0].body.subject).toEqual({ kind: "sales_funnel", id: FUNNEL, name: "Follow-up" });
    expect(crm[0].body.changes).toEqual([{ label: "Max budget", before: "none", after: "$10.50/month" }]);
  });

  it("a service write (no x-user-id) reports nothing", async () => {
    const res = await request(app).put(`/internal${campaignPath}`).set(service).send({ maxBudget: { amountCents: 2000, period: "daily" }, maxVolume: null });
    expect(res.status).toBe(200);
    await settle();
    expect(crm).toHaveLength(0);
  });

  it("crm-service failing or hanging leaves the budget route's answer unchanged", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = { maxBudget: { amountCents: 2000, period: "daily" }, maxVolume: null };
    crmAnswer = async () => new Response("boom", { status: 502 });
    const failed = await request(app).put(`/v1${campaignPath}`).set(person).send(body);
    await request(app).delete(`/v1${campaignPath}`).set(person);
    crmAnswer = () => new Promise(() => {});
    const t0 = Date.now();
    const hung = await request(app).put(`/v1${campaignPath}`).set(person).send(body);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(failed.status).toBe(200);
    expect(hung.status).toBe(200);
    expect(hung.body.maxBudget.amountCents).toBe(failed.body.maxBudget.amountCents);
  });

  it("the brand daily budget reports to crm-service, and billing sends no budget Telegram of its own", async () => {
    const patch = (cents: number) => request(app).patch(`/v1/brands/${brandId}/daily-budget`).set(person).send({ dailyBudgetCents: cents });
    expect((await patch(2000)).status).toBe(200);
    expect((await patch(2000)).status).toBe(200);
    expect((await patch(5000)).status).toBe(200);
    await settle();
    expect(crm).toHaveLength(2);
    expect(crm[1].body).toMatchObject({
      type: "campaign_budget_changed",
      subject: { kind: "brand", id: brandId },
      changes: [{ label: "Daily budget", before: "$20/day", after: "$50/day" }],
    });
    expect(tg.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("Budget"))).toEqual([]);
  });
});

describe("budgetChangeLines", () => {
  it("a no-op save has no line", () => {
    const s = { maxBudgetCents: "5000.0000000000", maxBudgetPeriod: "daily", maxVolume: 3, maxVolumePeriod: "one_off" };
    expect(budgetChangeLines(s, { ...s, maxBudgetCents: "5000" })).toEqual([]);
  });
  it("a period change is a change", () => {
    const s = { maxBudgetCents: "5000", maxBudgetPeriod: "daily", maxVolume: null, maxVolumePeriod: null };
    expect(budgetChangeLines(s, { ...s, maxBudgetPeriod: "weekly" })).toEqual([{ label: "Max budget", before: "$50/day", after: "$50/week" }]);
  });
});
