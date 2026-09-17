/**
 * Collect the debt when the customer opens a card session — and hand the session
 * over whatever the collection does.
 *
 * The rule these pin: an org that owes money on a chargeable card is charged for
 * it at click time, and NOTHING about that charge's outcome gates the session.
 * Refusing it trapped exactly the customer the card page exists for — their card
 * is dead, which is why the charge failed, which is why they came to replace it.
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

describe("outstanding balance is collected when a card-management session opens", () => {
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

  it("AC2: a DECLINING card still gets the session — no 402, no unsettled-balance code", async () => {
    await insertTestAccount({ orgId });
    owingFifty();
    // A declined off_session charge reaches billing as a throw (stripe-service
    // answers non-2xx) — the ordinary case, not an exotic one.
    ssMocks.reloadOffSession.mockRejectedValue(new Error("card_declined"));

    const res = await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://billing.stripe.com/p/session/abc");
    expect(JSON.stringify(res.body)).not.toContain("outstanding_balance");
    // The charge was still attempted, for exactly what is owed.
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(5000);
    expect(ssMocks.getCardSetup).toHaveBeenCalledTimes(1);
  });

  it("AC2b: a settled non-succeeded outcome also opens the session", async () => {
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

    expect(res.status).toBe(200);
    expect(ssMocks.getCardSetup).toHaveBeenCalledTimes(1);
  });

  it("a declined settle leaves a LOUD log line naming the org and the amount", async () => {
    await insertTestAccount({ orgId });
    owingFifty();
    ssMocks.reloadOffSession.mockRejectedValue(new Error("card_declined"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    const line = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toContain(orgId);
    expect(line).toContain("5000");
    expect(line).toMatch(/DECLINED/);
  });

  it("a balance that cannot be READ at all still opens the session", async () => {
    await insertTestAccount({ orgId });
    ssMocks.sumSucceededTopupsForOrg.mockRejectedValue(
      new Error("stripe-service unavailable")
    );

    const res = await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    expect(res.status).toBe(200);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
    expect(ssMocks.getCardSetup).toHaveBeenCalledTimes(1);
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

  it.each([
    ["a declining card", "declining"],
    ["a card that settles", "succeeding"],
    ["a non-negative balance", "positive"],
  ])(
    "POST /v1/accounts/card_setup behaves identically to /v1/portal-sessions on %s",
    async (_label, mode) => {
      await insertTestAccount({ orgId });
      if (mode === "positive") {
        ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("1000.0000000000");
        usageCents = "0.0000000000";
      } else {
        owingFifty();
        if (mode === "declining") {
          ssMocks.reloadOffSession.mockRejectedValue(new Error("card_declined"));
        }
      }

      const res = await request(app)
        .post("/v1/accounts/card_setup")
        .set(getAuthHeaders(orgId))
        .send({ return_url: "https://example.com/return" });

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain("outstanding_balance");
      expect(ssMocks.getCardSetup).toHaveBeenCalledTimes(1);
      expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(
        mode === "positive" ? 0 : 1
      );
    }
  );

  it("nothing in the repo can still produce the 402 refusal", async () => {
    await insertTestAccount({ orgId });
    owingFifty();
    ssMocks.reloadOffSession.mockRejectedValue(new Error("card_declined"));

    for (const path of ["/v1/portal-sessions", "/v1/accounts/card_setup"]) {
      const res = await request(app)
        .post(path)
        .set(getAuthHeaders(orgId))
        .send({ return_url: "https://example.com/return" });
      expect(res.status).not.toBe(402);
    }
  });
});
