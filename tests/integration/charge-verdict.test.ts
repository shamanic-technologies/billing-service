/**
 * The fast payment-hold verdict (FLEET-STALL-1107): `GET .../charge-verdict`.
 *
 * Pinned:
 *   - PARITY: on every case the verdict equals the payment outlook's
 *     `state === "charge_blocked"` + `blockedReason` (+ retry date). One decision
 *     (`chargeBlockFrom`), two reads.
 *   - INDEPENDENCE: it answers while runs-service, the burn read and
 *     campaign-service all fail (the reads that made the outlook take minutes).
 *   - FRESHNESS: a refusal billing records is seen on the very next read; card
 *     facts are held briefly and dropped when billing learns the card changed.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertTestAccount,
  insertTestSweepAttempt,
} from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { forgetCardFacts } from "../../src/lib/charge-verdict.js";

const orgId = "00000000-0000-0000-0000-0000000000e1";
const unknownOrgId = "00000000-0000-0000-0000-0000000000e9";
const apiKeyHeaders = { "X-API-Key": "test-api-key" };
const PAID = "25000.0000000000";

const verdictPath = (id: string) => `/internal/accounts/by-org/${id}/charge-verdict`;
const outlookPath = (id: string) => `/internal/accounts/by-org/${id}/payment-outlook`;

describe("GET /internal/accounts/by-org/:orgId/charge-verdict", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    forgetCardFacts();
    await cleanTestData();

    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@acme.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(PAID);
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-11-07T00:00:00.000Z",
    });
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    });
    const campaignClient = await import("../../src/lib/campaign-service-client.js");
    vi.spyOn(campaignClient, "fetchSpendableBudget").mockResolvedValue(null);
    const burn = await import("../../src/lib/realized-burn.js");
    vi.spyOn(burn, "fetchRealizedDailyBurn").mockResolvedValue({
      dailyCents: "1000.0000000000",
      unavailableReason: null,
      windowDays: 14,
    });
  });

  afterAll(async () => {
    forgetCardFacts();
    await cleanTestData();
    await closeDb();
  });

  async function both() {
    forgetCardFacts();
    const v = await request(app).get(verdictPath(orgId)).set(apiKeyHeaders);
    const o = await request(app).get(outlookPath(orgId)).set(apiKeyHeaders);
    expect(v.status).toBe(200);
    expect(o.status).toBe(200);
    return { v: v.body, o: o.body };
  }

  function expectParity(v: any, o: any) {
    expect(v.chargeBlocked).toBe(o.state === "charge_blocked");
    expect(v.blockedReason).toBe(o.blockedReason);
    expect(v.paymentMode).toBe(o.paymentMode);
    if (v.chargeBlocked) {
      expect(v.nextChargeAttemptAt).toBe(o.nextChargeAttemptAt);
      expect(v.trigger).toBe(o.trigger);
    }
  }

  it("404s with no billing account, 400s on a non-UUID", async () => {
    expect((await request(app).get(verdictPath(unknownOrgId)).set(apiKeyHeaders)).status).toBe(404);
    expect((await request(app).get(verdictPath("nope")).set(apiKeyHeaders)).status).toBe(400);
  });

  const cases: {
    name: string;
    setup: () => Promise<void>;
    blocked: boolean;
    reason: string | null;
  }[] = [
    {
      name: "postpaid with a card: chargeable",
      setup: async () => {
        await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
      },
      blocked: false,
      reason: null,
    },
    {
      name: "postpaid, no card: no_chargeable_card",
      setup: async () => {
        await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
        ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
        ssMocks.getOrgCardCountryByOrg.mockResolvedValue(null);
      },
      blocked: true,
      reason: "no_chargeable_card",
    },
    {
      name: "postpaid, India card: card_country_unsupported",
      setup: async () => {
        await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
        ssMocks.getOrgCardCountryByOrg.mockResolvedValue("IN");
      },
      blocked: true,
      reason: "card_country_unsupported",
    },
    {
      name: "postpaid, live refusal: card_declined with its retry rung",
      setup: async () => {
        await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
        await insertTestSweepAttempt({ orgId, creditedCentsAtAttempt: PAID, lastOutcome: "failed" });
      },
      blocked: true,
      reason: "card_declined",
    },
    {
      name: "postpaid, issuer called the card dead: card_unusable",
      setup: async () => {
        await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
        await insertTestSweepAttempt({
          orgId,
          creditedCentsAtAttempt: PAID,
          lastOutcome: "failed",
          cardUnusableAt: new Date(),
        });
      },
      blocked: true,
      reason: "card_unusable",
    },
    {
      name: "postpaid, every rung used: retries_exhausted",
      setup: async () => {
        await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
        await insertTestSweepAttempt({
          orgId,
          creditedCentsAtAttempt: PAID,
          lastOutcome: "failed",
          attemptCount: 5,
          firstFailedAt: new Date(Date.now() - 20 * 24 * 3600 * 1000),
        });
      },
      blocked: true,
      reason: "retries_exhausted",
    },
    {
      name: "refusal ended by money arriving (credited moved): chargeable",
      setup: async () => {
        await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
        await insertTestSweepAttempt({ orgId, creditedCentsAtAttempt: "100.0000000000", lastOutcome: "failed" });
      },
      blocked: false,
      reason: null,
    },
    {
      name: "prepaid, no card: never blocked",
      setup: async () => {
        await insertTestAccount({ orgId, paymentMode: "prepaid" });
        ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
        ssMocks.getOrgCardCountryByOrg.mockResolvedValue(null);
      },
      blocked: false,
      reason: null,
    },
    {
      name: "prepaid, live refusal: card_declined",
      setup: async () => {
        await insertTestAccount({ orgId, paymentMode: "prepaid", topupAmountCents: 5000, topupThresholdCents: 500 });
        await insertTestSweepAttempt({ orgId, creditedCentsAtAttempt: PAID, lastOutcome: "failed" });
      },
      blocked: true,
      reason: "card_declined",
    },
    {
      name: "subscription with a refusal row: never blocked",
      setup: async () => {
        await insertTestAccount({ orgId, paymentMode: "subscription" });
        await insertTestSweepAttempt({ orgId, creditedCentsAtAttempt: PAID, lastOutcome: "failed" });
      },
      blocked: false,
      reason: null,
    },
  ];

  for (const c of cases) {
    it(`parity with the payment outlook: ${c.name}`, async () => {
      await c.setup();
      const { v, o } = await both();
      expect(v.chargeBlocked).toBe(c.blocked);
      expect(v.blockedReason).toBe(c.reason);
      expectParity(v, o);
    });
  }

  it("answers while runs-service, the burn read and campaign-service all fail", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockRejectedValue(new Error("runs down"));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockRejectedValue(new Error("runs down"));
    const burn = await import("../../src/lib/realized-burn.js");
    vi.spyOn(burn, "fetchRealizedDailyBurn").mockRejectedValue(new Error("burn down"));
    const campaignClient = await import("../../src/lib/campaign-service-client.js");
    vi.spyOn(campaignClient, "fetchSpendableBudget").mockRejectedValue(new Error("campaign down"));

    const res = await request(app).get(verdictPath(orgId)).set(apiKeyHeaders);
    expect(res.status).toBe(200);
    expect(res.body.chargeBlocked).toBe(false);
    // The outlook still depends on them (unchanged).
    expect((await request(app).get(outlookPath(orgId)).set(apiKeyHeaders)).status).toBe(502);
  });

  it("asks stripe-service for no money figure when the org has no failed streak", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    ssMocks.sumSucceededTopupsForOrg.mockClear();
    const res = await request(app).get(verdictPath(orgId)).set(apiKeyHeaders);
    expect(res.status).toBe(200);
    expect(ssMocks.sumSucceededTopupsForOrg).not.toHaveBeenCalled();
  });

  it("a refusal recorded after a read is seen on the very next read", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    const first = await request(app).get(verdictPath(orgId)).set(apiKeyHeaders);
    expect(first.body.chargeBlocked).toBe(false);
    await insertTestSweepAttempt({ orgId, creditedCentsAtAttempt: PAID, lastOutcome: "failed" });
    const second = await request(app).get(verdictPath(orgId)).set(apiKeyHeaders);
    expect(second.body.chargeBlocked).toBe(true);
    expect(second.body.blockedReason).toBe("card_declined");
  });

  it("card facts are held briefly, and dropped when billing learns the card is gone", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    await request(app).get(verdictPath(orgId)).set(apiKeyHeaders);
    expect(ssMocks.hasChargeablePmForOrg).toHaveBeenCalledTimes(1);

    // Held: a second read inside the window does not ask stripe-service.
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
    const held = await request(app).get(verdictPath(orgId)).set(apiKeyHeaders);
    expect(held.body.chargeBlocked).toBe(false);
    expect(ssMocks.hasChargeablePmForOrg).toHaveBeenCalledTimes(1);

    // stripe-service reports the last card lost → dropped → next read is live.
    const flagger = await import("../../src/lib/unpaid-debt.js");
    vi.spyOn(flagger, "flagUncollectableDebt").mockResolvedValue({
      state: "no_debt",
      owedCents: "0",
    } as any);
    await request(app)
      .post("/internal/payment-methods/lost")
      .set(apiKeyHeaders)
      .send({ orgId });
    const after = await request(app).get(verdictPath(orgId)).set(apiKeyHeaders);
    expect(after.body.chargeBlocked).toBe(true);
    expect(after.body.blockedReason).toBe("no_chargeable_card");
  });

  it("card facts older than the fresh window are re-read", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 5000 });
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(realNow);
    await request(app).get(verdictPath(orgId)).set(apiKeyHeaders);
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
    // Past the max age: read live, no stale answer.
    nowSpy.mockReturnValue(realNow + 61_000);
    const res = await request(app).get(verdictPath(orgId)).set(apiKeyHeaders);
    expect(res.body.blockedReason).toBe("no_chargeable_card");
  });
});
