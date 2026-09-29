/**
 * The SaaS business in three figures (lib/revenue): recurring revenue, one-off
 * money with its run-out date, and cash — per org and fleet-wide.
 *
 * Pinned, each against the acceptance criteria:
 *   - the fleet MRR is the sum of the per-org rows;
 *   - every org lands in exactly one class;
 *   - a prepaid org without top-up shows a run-out date and contributes no MRR;
 *   - a reactive-only org has DRR 0;
 *   - the fleet cash over 30 days equals the sum of the per-org charge schedules;
 *   - an unreadable campaign-service is a NULL figure with a reason, never 0.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { brandSalesBudgets, campaignDailyBudgets } from "../../src/db/schema.js";
import type { RecurringCampaignStatus } from "../../src/lib/campaign-service-client.js";

const apiKeyHeaders = { "X-API-Key": "test-api-key" };

const RECURRING = "00000000-0000-0000-0000-00000000a001"; // postpaid, card, proactive + reactive
const ONE_OFF = "00000000-0000-0000-0000-00000000a002"; // prepaid, no top-up, $50 left
const REACTIVE = "00000000-0000-0000-0000-00000000a003"; // postpaid, card, reactive only
const NO_CARD = "00000000-0000-0000-0000-00000000a004"; // postpaid, no card
const CS_DOWN = "00000000-0000-0000-0000-00000000a005"; // campaign-service cannot answer
const GLOBAL = "00000000-0000-0000-0000-00000000a006"; // global sales budget brand

const brandOf = (org: string) => org.replace(/a0(\d\d)$/, "b0$1");
const OFFER = "00000000-0000-0000-0000-0000000000f1";
const ENTRY = "leg-entry";
const REPLY = "leg-from-reply";
const CHANNEL = "cold-email";

const PAID: Record<string, string> = {
  [RECURRING]: "25000.0000000000",
  [ONE_OFF]: "5000.0000000000",
  [REACTIVE]: "25000.0000000000",
  [NO_CARD]: "0",
  [CS_DOWN]: "25000.0000000000",
  [GLOBAL]: "25000.0000000000",
};
const USAGE: Record<string, string> = {
  [RECURRING]: "40000.0000000000", // −$150: owes, within the −$200 line
  [ONE_OFF]: "0",
  [REACTIVE]: "0",
  [NO_CARD]: "0",
  [CS_DOWN]: "0",
  [GLOBAL]: "0",
};

function status(
  org: string,
  id: string,
  over: Partial<RecurringCampaignStatus>
): RecurringCampaignStatus {
  return {
    campaignId: id,
    orgId: org,
    brandId: brandOf(org),
    offerId: OFFER,
    legKey: ENTRY,
    featureSlug: CHANNEL,
    status: "ongoing",
    running: true,
    executedByPlatform: true,
    kind: "proactive",
    audience: "available",
    allAudiencesExhausted: false,
    recurring: true,
    ...over,
  };
}

const STATUSES: Record<string, RecurringCampaignStatus[] | null> = {
  [RECURRING]: [
    status(RECURRING, "c-a1", {}),
    status(RECURRING, "c-a2", { legKey: REPLY, kind: "reactive", recurring: false }),
  ],
  [ONE_OFF]: [status(ONE_OFF, "c-b1", {})],
  [REACTIVE]: [status(REACTIVE, "c-c1", { legKey: REPLY, kind: "reactive", recurring: false })],
  [NO_CARD]: [status(NO_CARD, "c-d1", {})],
  [CS_DOWN]: null,
  [GLOBAL]: [
    status(GLOBAL, "c-f1", { audience: "exhausted", allAudiencesExhausted: true, recurring: false }),
    status(GLOBAL, "c-f2", { legKey: "leg-entry-2" }),
  ],
};

async function ceiling(org: string, legKey: string, cents: string) {
  await db.insert(campaignDailyBudgets).values({
    orgId: org,
    brandId: brandOf(org),
    featureSlug: CHANNEL,
    offerId: OFFER,
    legKey,
    dailyBudgetCents: cents,
  });
}

describe("revenue: recurring, one-off, cash", () => {
  const app = createTestApp();

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();

    const ss = setupStripeMocks();
    ss.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@acme.test"));
    ss.sumSucceededTopupsForOrg.mockImplementation(async (org: string) => PAID[org] ?? "0");
    ss.hasChargeablePmForOrg.mockImplementation(async (org: string) => org !== NO_CARD);
    ss.getOrgCardCountryByOrg.mockImplementation(async (org: string) =>
      org === NO_CARD ? null : "US"
    );

    const runs = await import("../../src/lib/runs-client.js");
    vi.spyOn(runs, "fetchRunsOrgUsageTotal").mockImplementation(async (org: string) => ({
      org_id: org,
      spent_cents: USAGE[org] ?? "0",
      as_of: "2026-09-29T00:00:00.000Z",
    }));
    vi.spyOn(runs, "fetchRunsOrgActualUsageTotal").mockImplementation(async (org: string) => ({
      spent_cents: USAGE[org] ?? "0",
    }));

    const cs = await import("../../src/lib/campaign-service-client.js");
    vi.spyOn(cs, "fetchSpendableBudget").mockResolvedValue(null);
    vi.spyOn(cs, "fetchRecurringCampaignStatuses").mockImplementation(async (org: string) => {
      const s = STATUSES[org];
      return s ? { ok: true, campaigns: s } : { ok: false, reason: "campaign_service_unavailable" };
    });

    const burn = await import("../../src/lib/realized-burn.js");
    vi.spyOn(burn, "fetchRealizedDailyBurn").mockResolvedValue({
      dailyCents: "1000.0000000000",
      unavailableReason: null,
      windowDays: 14,
    });

    await insertTestAccount({ orgId: RECURRING, topupAmountCents: 5000, topupThresholdCents: 5000 });
    await insertTestAccount({
      orgId: ONE_OFF,
      topupAmountCents: null,
      topupThresholdCents: null,
      paymentMode: "prepaid",
    });
    await insertTestAccount({ orgId: REACTIVE, topupAmountCents: 5000, topupThresholdCents: 5000 });
    await insertTestAccount({ orgId: NO_CARD, topupAmountCents: null, topupThresholdCents: null });
    await insertTestAccount({ orgId: CS_DOWN, topupAmountCents: 5000, topupThresholdCents: 5000 });
    await insertTestAccount({ orgId: GLOBAL, topupAmountCents: 5000, topupThresholdCents: 5000 });

    await ceiling(RECURRING, ENTRY, "5000");
    await ceiling(RECURRING, REPLY, "3000");
    await ceiling(ONE_OFF, ENTRY, "1000");
    await ceiling(REACTIVE, REPLY, "3000");
    await ceiling(NO_CARD, ENTRY, "2000");
    await ceiling(CS_DOWN, ENTRY, "4000");
    await db.insert(brandSalesBudgets).values({
      orgId: GLOBAL,
      brandId: brandOf(GLOBAL),
      dailyBudgetCents: "7000",
    });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("recurring postpaid org: DRR = its proactive ceilings only, MRR x30, ARR x12", async () => {
    const res = await request(app).get(`/internal/revenue/by-org/${RECURRING}`).set(apiKeyHeaders);
    expect(res.status).toBe(200);
    expect(res.body.revenueClass).toBe("recurring");
    expect(res.body.classReason).toBe("postpaid_chargeable_card");
    expect(res.body.drrCents).toBe("5000.0000000000");
    expect(res.body.mrrCents).toBe("150000.0000000000");
    expect(res.body.arrCents).toBe("1800000.0000000000");
    expect(res.body.oneOff).toBeNull();
    const counted = res.body.campaigns.filter((c: { counted: boolean }) => c.counted);
    expect(counted.map((c: { campaignId: string }) => c.campaignId)).toEqual(["c-a1"]);
    expect(res.body.projections).toEqual([
      { horizonDays: 30, recurringCents: "150000.0000000000", oneOffCents: "0.0000000000", totalCents: "150000.0000000000" },
      { horizonDays: 90, recurringCents: "450000.0000000000", oneOffCents: "0.0000000000", totalCents: "450000.0000000000" },
    ]);
    expect(res.body.cash.events.length).toBeGreaterThan(0);
  });

  it("prepaid without top-up: one-off, run-out date, no MRR", async () => {
    const res = await request(app).get(`/internal/revenue/by-org/${ONE_OFF}`).set(apiKeyHeaders);
    expect(res.status).toBe(200);
    expect(res.body.revenueClass).toBe("one_off");
    expect(res.body.classReason).toBe("prepaid_no_auto_topup");
    expect(res.body.drrCents).toBe("0.0000000000");
    expect(res.body.mrrCents).toBe("0.0000000000");
    expect(res.body.oneOff.remainingCents).toBe("5000.0000000000");
    expect(res.body.oneOff.dailyPaceCents).toBe("1000.0000000000");
    const days = (new Date(res.body.oneOff.runOutAt).getTime() - new Date(res.body.asOf).getTime()) / 86_400_000;
    expect(days).toBeCloseTo(5, 5);
    // $50 at $10/day: all of it inside 30 days, capped by run-out.
    expect(res.body.projections[0].oneOffCents).toBe("5000.0000000000");
    expect(res.body.cash.events).toEqual([]);
  });

  it("reactive-only org has DRR 0; card-less postpaid is none; campaign-service down is null with a reason", async () => {
    const reactive = await request(app).get(`/internal/revenue/by-org/${REACTIVE}`).set(apiKeyHeaders);
    expect(reactive.body.revenueClass).toBe("recurring");
    expect(reactive.body.drrCents).toBe("0.0000000000");

    const noCard = await request(app).get(`/internal/revenue/by-org/${NO_CARD}`).set(apiKeyHeaders);
    expect(noCard.body.revenueClass).toBe("none");
    expect(noCard.body.classReason).toBe("postpaid_no_chargeable_card");
    expect(noCard.body.drrCents).toBe("0.0000000000");

    const down = await request(app).get(`/internal/revenue/by-org/${CS_DOWN}`).set(apiKeyHeaders);
    expect(down.body.revenueClass).toBe("recurring");
    expect(down.body.drrCents).toBeNull();
    expect(down.body.mrrCents).toBeNull();
    expect(down.body.proactiveDailyBudgetUnknownReason).toBe("campaign_service_unavailable");
    expect(down.body.projections[0].totalCents).toBeNull();
  });

  it("a global-mode brand counts its one amount while any campaign is recurring", async () => {
    const res = await request(app).get(`/internal/revenue/by-org/${GLOBAL}`).set(apiKeyHeaders);
    expect(res.body.drrCents).toBe("7000.0000000000");
    expect(res.body.brands[0].mode).toBe("global");
  });

  it("fleet: one class per org, MRR = sum of rows, 30-day cash = sum of per-org schedules", async () => {
    const res = await request(app).get("/internal/revenue/fleet").set(apiKeyHeaders);
    expect(res.status).toBe(200);
    const body = res.body;

    expect(body.accountCount).toBe(6);
    expect(body.orgs).toHaveLength(6);
    expect(body.unreadableOrgs).toEqual([]);
    const counts = body.classCounts;
    expect(counts.recurring + counts.one_off + counts.none).toBe(6);
    expect(counts).toEqual({ recurring: 4, one_off: 1, none: 1 });

    const known = body.orgs.filter((o: { mrrCents: string | null }) => o.mrrCents !== null);
    const mrrSum = known.reduce((s: Decimal, o: { mrrCents: string }) => s.plus(o.mrrCents), new Decimal(0));
    expect(new Decimal(body.totals.mrrCents).equals(mrrSum)).toBe(true);
    expect(body.totals.mrrCents).toBe("360000.0000000000"); // (5000 + 7000) x 30
    expect(body.totals.drrUnknownOrgIds).toEqual([CS_DOWN]);
    expect(body.totals.oneOffRemainingCents).toBe("5000.0000000000");

    // Cash: the fleet window equals the per-org schedules over the same window.
    const { getChargeSchedule } = await import("../../src/lib/charge-schedule.js");
    const now = new Date(body.asOf);
    let perOrg = new Decimal(0);
    for (const o of body.orgs as { orgId: string }[]) {
      const s = await getChargeSchedule(o.orgId, 30, now);
      perOrg = perOrg.plus(s!.expectedTotalCents ?? "0");
    }
    const w30 = body.totals.windows.find((w: { horizonDays: number }) => w.horizonDays === 30);
    expect(new Decimal(w30.cashCents).equals(perOrg)).toBe(true);
    expect(perOrg.greaterThan(0)).toBe(true);

    const bucketSum = (body.cashFlow.byWeek as { amountCents: string }[]).reduce(
      (s, b) => s.plus(b.amountCents),
      new Decimal(0)
    );
    const allEvents = (body.orgs as { cashEvents: { expectedAmountCents: string | null }[] }[])
      .flatMap((o) => o.cashEvents)
      .reduce((s, e) => s.plus(e.expectedAmountCents ?? "0"), new Decimal(0));
    expect(bucketSum.equals(allEvents)).toBe(true);
  });

  it("400s on a bad orgId or horizon, 404s for an unknown org", async () => {
    expect((await request(app).get("/internal/revenue/by-org/nope").set(apiKeyHeaders)).status).toBe(400);
    expect(
      (await request(app).get("/internal/revenue/by-org/00000000-0000-0000-0000-00000000a0ff").set(apiKeyHeaders)).status
    ).toBe(404);
    expect((await request(app).get("/internal/revenue/fleet?cashHorizonDays=30").set(apiKeyHeaders)).status).toBe(400);
  });
});
