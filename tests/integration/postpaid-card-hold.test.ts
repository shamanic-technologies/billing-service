/**
 * CARD-HOLD-50-1022 (owner 2026-10-22): a postpaid org gets its credit line only once
 * a $50 authorization hold on its card was accepted. Refused = no line, no spend, the
 * wall says why. A step reached while the hold is alive is paid by CAPTURING it (no
 * second charge), then ONE hold for the next step is placed. An expired hold changes
 * nothing: the step charges as today. Orgs already postpaid are grandfathered.
 */

import { describe, it, expect, beforeEach, afterAll, vi, beforeAll } from "vitest";
import { useMatchOfferDefaults, restoreCurrentOfferDefaults } from "../helpers/test-db.js";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount, restoreCurrentOfferDefaults } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail, mockCardHold } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { billingAccounts } from "../../src/db/schema.js";
import { _resetCoalescer } from "../../src/lib/reload-coalescer.js";
import * as ssClient from "../../src/lib/stripe-service-client.js";
import * as reload from "../../src/lib/reload.js";
import { CREDIT_LINE_HOLD_PURPOSE } from "../../src/lib/postpaid-card-check.js";

const orgId = "00000000-0000-0000-0000-0000000008a1";
const campaignId = "00000000-0000-0000-0000-0000000008c1";

describe("postpaid card check: $50 hold before credit, captured at the step", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let usage = "0.0000000000";
  let chargeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    _resetCoalescer();
    await cleanTestData();
    await useMatchOfferDefaults();
    usage = "0.0000000000";

    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@staff-test.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");
    chargeSpy = vi.spyOn(ssClient, "chargeOrgOffSession").mockResolvedValue({
      object: "charge",
      status: "succeeded",
      reference: "pi_charge",
    } as never);

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage,
      as_of: "2026-10-22T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: usage,
      as_of: "2026-10-22T00:00:00.000Z",
    }));
    const costs = await import("../../src/lib/costs-client.js");
    vi.spyOn(costs, "resolveRequiredCents").mockResolvedValue("100.0000000000");
  });

  // Written against a fresh account of the match_100 era (pre-0093).
  beforeAll(async () => {
    await useMatchOfferDefaults();
  });

  afterAll(async () => {
    await restoreCurrentOfferDefaults();
    await closeDb();
  });

  const choosePostpaid = () =>
    request(app).put("/v1/accounts/payment_mode").set(getAuthHeaders(orgId)).send({ payment_mode: "postpaid" });
  const authorize = () =>
    request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId), "x-campaign-id": campaignId })
      .send({ items: [{ costName: "x", quantity: 1 }] });
  const account = async () =>
    (await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId)))[0];

  it("a card with funds: the $50 hold is accepted, the credit line opens, nothing is charged", async () => {
    const res = await choosePostpaid();
    expect(res.status).toBe(200);
    expect(ssMocks.placeCardHold).toHaveBeenCalledTimes(1);
    const [holdOrg, body, key] = ssMocks.placeCardHold.mock.calls[0];
    expect(holdOrg).toBe(orgId);
    expect(body).toMatchObject({
      amount: 5000,
      currency: "usd",
      session: "on_session", // the customer is on the wall: 3-D Secure is a challenge, not a refusal
      metadata: { billing_purpose: CREDIT_LINE_HOLD_PURPOSE },
    });
    expect(key).toMatch(new RegExp(`^postpaid-card-check:${orgId}:pm_mock:\\d{4}-\\d{2}-\\d{2}:on_session$`));
    expect((await account()).postpaidCardCheck).toBe("passed");
    expect(chargeSpy).not.toHaveBeenCalled();

    const acct = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(acct.body.postpaid_card_check).toBe("passed");
    expect(acct.body.credit_line_cents).toBe(5000);

    usage = "4500.0000000000"; // -$45, inside the $50 line
    const ok = await authorize();
    expect(ok.body.sufficient).toBe(true);
  });

  it("an insufficient-funds card is refused at the wall: no credit line, no spend", async () => {
    ssMocks.placeCardHold.mockResolvedValue(
      mockCardHold({
        status: "refused",
        failure: { type: "card_declined", code: "insufficient_funds", message: "Your card has insufficient funds." },
      })
    );
    const res = await choosePostpaid();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("postpaid_card_hold_refused");
    expect(res.body.card_refused_reason).toBe("card_hold_refused");
    expect(res.body.error).toContain("Your card has insufficient funds.");

    const row = await account();
    expect(row.postpaidCardCheck).toBe("refused");
    expect(row.postpaidCardCheckMessage).toBe("Your card has insufficient funds.");

    const acct = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(acct.body.credit_line_cents).toBeNull();
    expect(acct.body.postpaid_card_check).toBe("refused");

    usage = "100.0000000000"; // $0 balance (no advance on postpaid) - $1 = -$1
    const refused = await authorize();
    expect(refused.body.sufficient).toBe(false);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("a card saved but never checked carries no credit line", async () => {
    await request(app).get("/v1/accounts").set(getAuthHeaders(orgId)); // creates the account
    expect((await account()).postpaidCardCheck).toBe("required");
    usage = "3100.0000000000"; // $30 advance - $31 = -$1
    const res = await authorize();
    expect(res.body.sufficient).toBe(false);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("a bank that wants 3-D Secure: 409 with the client secret, then the same hold re-read opens the line", async () => {
    const pending = mockCardHold({ status: "requires_action", client_secret: "pi_hold_secret_abc", expires_at: null });
    ssMocks.placeCardHold.mockResolvedValueOnce(pending);
    const first = await choosePostpaid();
    expect(first.status).toBe(409);
    expect(first.body.code).toBe("postpaid_card_hold_requires_action");
    expect(first.body.client_secret).toBe("pi_hold_secret_abc");
    expect((await account()).postpaidCardCheck).toBe("required");

    // The page ran handleNextAction; the second call replays the SAME key and reads held.
    ssMocks.placeCardHold.mockResolvedValueOnce(mockCardHold({ status: "held" }));
    const second = await choosePostpaid();
    expect(second.status).toBe(200);
    expect(ssMocks.placeCardHold.mock.calls[1][2]).toBe(ssMocks.placeCardHold.mock.calls[0][2]);
    expect((await account()).postpaidCardCheck).toBe("passed");
  });

  it("staff switching an org to postpaid checks the card off-session (nobody to answer a challenge)", async () => {
    await request(app).get("/v1/accounts").set(getAuthHeaders(orgId)); // creates the account
    const res = await request(app)
      .put(`/internal/accounts/by-org/${orgId}/payment-mode`)
      .set(getAuthHeaders(orgId))
      .send({ payment_mode: "postpaid" });
    expect(res.status).toBe(200);
    expect(ssMocks.placeCardHold.mock.calls[0][1]).toMatchObject({ session: "off_session" });
  });

  it("the bank could not be asked: 502, the check stays required", async () => {
    ssMocks.placeCardHold.mockRejectedValue(
      new ssClient.CardHoldUnavailableError(502, "acquirer_unavailable", "acquirer down")
    );
    const res = await choosePostpaid();
    expect(res.status).toBe(502);
    expect((await account()).postpaidCardCheck).toBe("required");
  });

  it("an org already postpaid before the check (grandfathered) is never held", async () => {
    await insertTestAccount({ orgId, paymentMode: "postpaid", postpaidCardCheck: "grandfathered" });
    const res = await choosePostpaid();
    expect(res.status).toBe(200);
    expect(ssMocks.placeCardHold).not.toHaveBeenCalled();
  });

  describe("paying a step", () => {
    beforeEach(async () => {
      vi.mocked(reload.reloadOffSession).mockRestore();
      await insertTestAccount({ orgId, paymentMode: "postpaid", postpaidCardCheck: "passed" });
    });

    it("spend reaches $50 while the hold is alive: the hold is captured, no second charge, next-step hold placed", async () => {
      const live = mockCardHold({ id: "22222222-2222-4222-8222-222222222222", amount: 5000 });
      ssMocks.getLiveCardHold.mockResolvedValue(live);
      ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("20000.0000000000"); // after capture → $200 step

      const out = await reload.reloadOffSession(orgId, 5000, "key-1", { reason: "postpaid_step" });
      expect(out.status).toBe("succeeded");
      expect(ssMocks.captureCardHold).toHaveBeenCalledWith(orgId, live.id, 5000);
      expect(chargeSpy).not.toHaveBeenCalled();

      await vi.waitFor(() => expect(ssMocks.placeCardHold).toHaveBeenCalledTimes(1));
      const [, body, key] = ssMocks.placeCardHold.mock.calls[0];
      expect(body).toMatchObject({ amount: 20000, session: "off_session", metadata: { billing_purpose: CREDIT_LINE_HOLD_PURPOSE } });
      expect(key).toBe(`postpaid-next-step-hold:${orgId}:${live.id}`);
    });

    it("owing less than the hold captures only what is owed", async () => {
      ssMocks.getLiveCardHold.mockResolvedValue(mockCardHold({ amount: 5000 }));
      await reload.reloadOffSession(orgId, 1234, "key-2");
      expect(ssMocks.captureCardHold).toHaveBeenCalledWith(orgId, expect.any(String), 1234);
      expect(chargeSpy).not.toHaveBeenCalled();
    });

    it("the hold expired before the step: the step charges as today", async () => {
      ssMocks.getLiveCardHold.mockResolvedValue(null);
      const out = await reload.reloadOffSession(orgId, 5000, "key-3");
      expect(out.status).toBe("succeeded");
      expect(ssMocks.captureCardHold).not.toHaveBeenCalled();
      expect(chargeSpy).toHaveBeenCalledTimes(1);
      expect(ssMocks.placeCardHold).not.toHaveBeenCalled(); // never renewed
    });

    it("the hold went away at capture: the step charges as today", async () => {
      ssMocks.getLiveCardHold.mockResolvedValue(mockCardHold());
      ssMocks.captureCardHold.mockResolvedValue(null);
      await reload.reloadOffSession(orgId, 5000, "key-4");
      expect(chargeSpy).toHaveBeenCalledTimes(1);
    });

    it("a charge bigger than the hold charges the card, the hold is left to expire", async () => {
      ssMocks.getLiveCardHold.mockResolvedValue(mockCardHold({ amount: 5000 }));
      await reload.reloadOffSession(orgId, 10000, "key-5");
      expect(ssMocks.captureCardHold).not.toHaveBeenCalled();
      expect(chargeSpy).toHaveBeenCalledTimes(1);
    });

    it("a card-verification hold (another purpose) is never captured", async () => {
      ssMocks.getLiveCardHold.mockResolvedValue(mockCardHold({ metadata: { purpose: "card-hold" } }));
      await reload.reloadOffSession(orgId, 5000, "key-6");
      expect(ssMocks.captureCardHold).not.toHaveBeenCalled();
      expect(chargeSpy).toHaveBeenCalledTimes(1);
    });

    it("a prepaid org never reads holds", async () => {
      await db.update(billingAccounts).set({ paymentMode: "prepaid" }).where(eq(billingAccounts.orgId, orgId));
      await reload.reloadOffSession(orgId, 5000, "key-7");
      expect(ssMocks.getLiveCardHold).not.toHaveBeenCalled();
      expect(chargeSpy).toHaveBeenCalledTimes(1);
    });
  });
});
