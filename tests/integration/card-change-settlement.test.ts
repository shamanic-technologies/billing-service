/**
 * Settle the debt before the customer may change the card that owes it.
 *
 * The rule these pin: an org that owes money on a chargeable card pays it before
 * a card-management session is handed over, and a refusal says what is owed in a
 * shape the dashboard can tell apart from every other failure. The two carve-outs
 * (no card, off_session-blocked card) matter as much as the rule — refusing there
 * would trap an org in a debt it can never pay.
 *
 * Own file rather than a describe appended to portal.test.ts: that one closes the
 * shared postgres.js connection in afterAll (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import * as runsClient from "../../src/lib/runs-client.js";
import {
  cardChangeSettleIdempotencyKey,
  dayBucket,
} from "../../src/lib/card-change-settlement.js";

const app = createTestApp();
const orgId = "00000000-0000-0000-0000-0000000000d1";

describe("outstanding balance is settled before a card-management session", () => {
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let usageCents: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();

    // balance = credited − usage. credited comes from sumSucceededTopupsForOrg
    // (no promos in these fixtures); usage is driven per-test.
    usageCents = "0.0000000000";
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(
      async (org: string) => ({
        org_id: org,
        spent_cents: usageCents,
        as_of: "2026-01-31T00:00:00.000Z",
      })
    );
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  /** Put the org at exactly −$50: paid $10, used $60. */
  function owingFifty() {
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("1000.0000000000");
    usageCents = "6000.0000000000";
  }

  it("AC1: charges the outstanding $50 on the saved card, then opens the session", async () => {
    await insertTestAccount({ orgId });
    owingFifty();

    const res = await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://billing.stripe.com/p/session/abc");
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    const [chargedOrg, chargedCents, key] = ssMocks.reloadOffSession.mock.calls[0];
    expect(chargedOrg).toBe(orgId);
    // EXACTLY the outstanding amount — the same arithmetic the month-end sweep
    // bills, never a tier multiple.
    expect(chargedCents).toBe(5000);
    expect(key).toBe(
      cardChangeSettleIdempotencyKey(orgId, dayBucket(new Date()), 5000)
    );
  });

  it("AC1b: a retry carries the SAME idempotency key, so it cannot double charge", async () => {
    await insertTestAccount({ orgId });
    owingFifty();
    const headers = getAuthHeaders(orgId);
    const body = { return_url: "https://example.com/return" };

    await request(app).post("/v1/portal-sessions").set(headers).send(body);
    // The mirror has not caught up within the retry window, so the balance still
    // reads −$50 and the second attempt computes the same amount.
    await request(app).post("/v1/portal-sessions").set(headers).send(body);

    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(2);
    const keys = ssMocks.reloadOffSession.mock.calls.map((c) => c[2]);
    expect(keys[0]).toBe(keys[1]);
  });

  it("AC2: a declining card gets NO session and a 402 stating what is owed", async () => {
    await insertTestAccount({ orgId });
    owingFifty();
    // A declined off_session charge reaches billing as a throw (stripe-service
    // answers non-2xx) — the ordinary case, not an exotic one.
    ssMocks.reloadOffSession.mockRejectedValue(new Error("card_declined"));

    const res = await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("outstanding_balance_unsettled");
    expect(res.body.owed_cents).toBe("5000");
    expect(res.body.balance_cents).toBe("-5000.0000000000");
    expect(res.body.reason).toBe("charge_failed");
    expect(ssMocks.getCardSetup).not.toHaveBeenCalled();
  });

  it("AC2b: a settled non-succeeded outcome also refuses, and never opens a session", async () => {
    await insertTestAccount({ orgId });
    owingFifty();
    ssMocks.reloadOffSession.mockResolvedValue({
      status: "failed",
      failure_reason: "insufficient_funds",
    });

    const res = await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    expect(res.status).toBe(402);
    expect(res.body.reason).toBe("charge_failed");
    expect(ssMocks.getCardSetup).not.toHaveBeenCalled();
  });

  it("AC3: a positive balance opens the session exactly as before, with no charge", async () => {
    await insertTestAccount({ orgId });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("1000.0000000000");
    usageCents = "0.0000000000";

    const res = await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    expect(res.status).toBe(200);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("a debtor with NO card still gets the session — adding one is the only way out", async () => {
    await insertTestAccount({ orgId });
    owingFifty();
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);

    const res = await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    expect(res.status).toBe(200);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("a debtor whose card cannot be charged off_session still gets the session", async () => {
    await insertTestAccount({ orgId });
    owingFifty();
    // India / RBI: no off_session settle is possible on this card at all, so
    // blocking the one screen where the customer could act is pure harm.
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("IN");

    const res = await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    expect(res.status).toBe(200);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("a deficit below Stripe's minimum charge opens the session and rolls into the sweep", async () => {
    await insertTestAccount({ orgId });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("1000.0000000000");
    usageCents = "1000.2000000000"; // −0.20 cents owed, under the 50-cent minimum

    const res = await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    expect(res.status).toBe(200);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("POST /v1/accounts/card_setup gates identically — the rule is not one URL away from bypass", async () => {
    await insertTestAccount({ orgId });
    owingFifty();
    ssMocks.reloadOffSession.mockRejectedValue(new Error("card_declined"));

    const res = await request(app)
      .post("/v1/accounts/card_setup")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("outstanding_balance_unsettled");
    expect(res.body.owed_cents).toBe("5000");
    expect(ssMocks.getCardSetup).not.toHaveBeenCalled();
  });
});
