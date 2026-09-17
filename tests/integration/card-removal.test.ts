/**
 * Removing the card we hold, as an ordinary self-serve action.
 *
 * The rules these pin: what is owed is collected FIRST on the card that is about
 * to go, the removal happens whatever that collection did, nothing is forgiven,
 * and auto-topup is not left armed on an org with no card.
 *
 * Own file rather than a describe appended to accounts.test.ts: that one closes
 * the shared postgres.js connection in afterAll (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { billingAccounts, creditDepletionEpisodes } from "../../src/db/schema.js";
import * as runsClient from "../../src/lib/runs-client.js";
import {
  cardChangeSettleIdempotencyKey,
  dayBucket,
} from "../../src/lib/card-change-settlement.js";

const app = createTestApp();
const orgId = "00000000-0000-0000-0000-0000000000e1";
const REMOVE = "/v1/accounts/saved_payment_method";

describe("a customer can stop us holding their card", () => {
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let usageCents: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();

    usageCents = "0.0000000000";
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(
      async (org: string) => ({
        org_id: org,
        spent_cents: usageCents,
        as_of: "2026-01-31T00:00:00.000Z",
      })
    );
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: usageCents,
    } as never);
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

  // --- 1. the ordinary case: nothing owed ---

  it("AC1: removes the card and charges nothing when the org owes nothing", async () => {
    await insertTestAccount({ orgId });

    const res = await request(app).delete(REMOVE).set(getAuthHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("saved_payment_method_removed");
    expect(res.body.removed).toBe(1);
    expect(res.body.settled_cents).toBe(0);
    expect(res.body.settle_skip_reason).toBe("nothing_owed");
    expect(ssMocks.removeSavedPaymentMethods).toHaveBeenCalledWith(orgId);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  // --- 2. a debtor pays at the moment they touch the card that owes it ---

  it("AC2: collects the outstanding $50 on the card that is about to go, then removes it", async () => {
    await insertTestAccount({ orgId });
    owingFifty();

    const res = await request(app).delete(REMOVE).set(getAuthHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body.settled_cents).toBe(5000);
    expect(res.body.settle_skip_reason).toBeUndefined();

    // EXACTLY the outstanding amount, under the card-change rule's own key.
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    const [chargedOrg, chargedCents, key] = ssMocks.reloadOffSession.mock.calls[0];
    expect(chargedOrg).toBe(orgId);
    expect(chargedCents).toBe(5000);
    expect(key).toBe(cardChangeSettleIdempotencyKey(orgId, dayBucket(new Date()), 5000));

    // Collected BEFORE the card went.
    const chargeOrder = ssMocks.reloadOffSession.mock.invocationCallOrder[0];
    const detachOrder = ssMocks.removeSavedPaymentMethods.mock.invocationCallOrder[0];
    expect(chargeOrder).toBeLessThan(detachOrder);
  });

  // --- 3. the collection NEVER gates the removal ---

  it("AC3: removes the card even when the charge is DECLINED, and forgives nothing", async () => {
    await insertTestAccount({ orgId });
    owingFifty();
    ssMocks.reloadOffSession.mockRejectedValue(new Error("card_declined"));

    const res = await request(app).delete(REMOVE).set(getAuthHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(1);
    expect(res.body.settled_cents).toBe(0);
    expect(res.body.settle_skip_reason).toBe("charge_failed");
    expect(ssMocks.removeSavedPaymentMethods).toHaveBeenCalledTimes(1);

    // Nothing was erased, adjusted or marked settled: the balance still reads
    // −$50 and the debt stays owned by the existing sweeps.
    const balance = await request(app)
      .get("/v1/accounts/balance")
      .set(getAuthHeaders(orgId));
    expect(balance.status).toBe(200);
    expect(Number(balance.body.balance_cents)).toBe(-5000);
  });

  it("AC3b: removes the card when the balance itself cannot be read", async () => {
    await insertTestAccount({ orgId });
    ssMocks.sumSucceededTopupsForOrg.mockRejectedValue(new Error("stripe-service down"));

    const res = await request(app).delete(REMOVE).set(getAuthHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body.settle_skip_reason).toBe("balance_unavailable");
    expect(ssMocks.removeSavedPaymentMethods).toHaveBeenCalledTimes(1);
  });

  // --- 4. an org with no card is not an error ---

  it("AC4: an org with nothing to remove succeeds", async () => {
    await insertTestAccount({ orgId });
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
    ssMocks.removeSavedPaymentMethods.mockResolvedValue({
      object: "payment_methods_removed",
      org_id: orgId,
      acquirer: "stripe",
      customer: null,
      detached: [],
      already_detached: [],
    });

    const res = await request(app).delete(REMOVE).set(getAuthHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(0);
    expect(res.body.already_removed).toBe(0);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  // --- 5. auto-topup is not left armed against an org with no card ---

  it("AC5: disarms auto-topup, so no threshold is left that can never fire", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 2000 });

    const res = await request(app).delete(REMOVE).set(getAuthHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body.auto_topup_disarmed).toBe(true);

    const [row] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);
    expect(row.topupAmountCents).toBeNull();
    expect(row.topupThresholdCents).toBeNull();

    const account = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(account.body.has_auto_topup).toBe(false);
  });

  it("AC5b: says so when there was no auto-topup to disarm", async () => {
    await insertTestAccount({ orgId });

    const res = await request(app).delete(REMOVE).set(getAuthHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body.auto_topup_disarmed).toBe(false);
  });

  // --- 6. a failure a gateway can pass on, never a silent success ---

  it("AC6: answers 502 when the removal could not be performed, and leaves auto-topup armed", async () => {
    await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 2000 });
    ssMocks.removeSavedPaymentMethods.mockRejectedValue(new Error("stripe-service unreachable"));

    const res = await request(app).delete(REMOVE).set(getAuthHeaders(orgId));

    expect(res.status).toBe(502);
    expect(res.body.error).toBeTruthy();

    // The card may still be on file, so the configuration that would charge it
    // must not have been torn down.
    const [row] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);
    expect(row.topupAmountCents).toBe(5000);
  });

  it("404s for an org with no billing account", async () => {
    const res = await request(app)
      .delete(REMOVE)
      .set(getAuthHeaders("00000000-0000-0000-0000-0000000000e9"));

    expect(res.status).toBe(404);
    expect(ssMocks.removeSavedPaymentMethods).not.toHaveBeenCalled();
  });

  // --- 7. the after-state is the existing one, and is NOT run inline ---

  it("does not flag the uncollectable debt inline — the detach event drives that", async () => {
    await insertTestAccount({ orgId });
    owingFifty();
    ssMocks.reloadOffSession.mockRejectedValue(new Error("card_declined"));

    const res = await request(app).delete(REMOVE).set(getAuthHeaders(orgId));
    expect(res.status).toBe(200);

    // stripe-service emits payment_method.detached for a detach WE initiate
    // exactly as for one the customer performs, and that event is what opens the
    // episode, mails the customer and surfaces the org to staff. Doing it here
    // as well would make one detach two notifications.
    const episodes = await db
      .select()
      .from(creditDepletionEpisodes)
      .where(eq(creditDepletionEpisodes.orgId, orgId));
    expect(episodes).toHaveLength(0);
  });
});
