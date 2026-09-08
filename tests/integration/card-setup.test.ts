import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

/**
 * Giving us a card from inside the dashboard, and never arming an automatic
 * charge without one.
 *
 * The whole point of the second acquirer's half of this is that "we could not
 * ask" is a THIRD answer. Every case below exists to keep it apart from "there
 * is no card": collapsed one way a customer re-enters a card we already hold,
 * collapsed the other we arm a recurring charge off a timeout.
 */
describe("card setup + saved-card confirmation", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-05-13T00:00:00.000Z",
    } as never);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  // --- 1. what the browser needs to render the form, and nothing more ---

  it("passes the embedded-widget descriptor through, credentials and all absent", async () => {
    await insertTestAccount({ orgId });
    ssMocks.getCardSetup.mockResolvedValue({
      object: "card_setup",
      mode: "embedded_widget",
      script_url: "https://sdk.example.com/upi.js",
      environment: "prod",
      token: "per_order_public_token",
      save_payment_method_for: "merchant",
    });

    const res = await request(app)
      .post("/v1/accounts/card_setup")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      object: "card_setup",
      mode: "embedded_widget",
      script_url: "https://sdk.example.com/upi.js",
      environment: "prod",
      token: "per_order_public_token",
      save_payment_method_for: "merchant",
    });
    // Nothing is added on the way through, so nothing can leak on the way
    // through: no api key, no merchant key, no customer id.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("test-stripe-key");
    expect(serialized).not.toContain("api_key");
    expect(ssMocks.getCardSetup).toHaveBeenCalledWith(
      orgId,
      "https://example.com/return",
      undefined,
      undefined
    );
  });

  it("keeps the hosted-redirect descriptor exactly as the acquirer describes it", async () => {
    await insertTestAccount({ orgId });

    const res = await request(app)
      .post("/v1/accounts/card_setup")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return", currency: "USD" });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("hosted_redirect");
    expect(res.body.url).toBe("https://billing.stripe.com/p/session/abc");
    expect(ssMocks.getCardSetup).toHaveBeenCalledWith(
      orgId,
      "https://example.com/return",
      undefined,
      "USD"
    );
  });

  it("rejects a request with no return_url and 404s an org with no account", async () => {
    await insertTestAccount({ orgId });
    const bad = await request(app)
      .post("/v1/accounts/card_setup")
      .set(getAuthHeaders(orgId))
      .send({});
    expect(bad.status).toBe(400);

    const other = "00000000-0000-0000-0000-0000000000ff";
    const missing = await request(app)
      .post("/v1/accounts/card_setup")
      .set(getAuthHeaders(other))
      .send({ return_url: "https://example.com/return" });
    expect(missing.status).toBe(404);
  });

  it("502s when the acquirer could not be asked how to add a card", async () => {
    await insertTestAccount({ orgId });
    ssMocks.getCardSetup.mockRejectedValue(new Error("stripe-service down"));

    const res = await request(app)
      .post("/v1/accounts/card_setup")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    expect(res.status).toBe(502);
  });

  // --- 2. the three answers, kept apart ---

  it("answers SAVED with the method that would be charged", async () => {
    await insertTestAccount({ orgId });
    ssMocks.getSavedPaymentMethod.mockResolvedValue({
      object: "saved_payment_method",
      org_id: orgId,
      acquirer: "revolut",
      saved: true,
      method: { id: "pm_1", type: "card", saved_for: "merchant" },
    });

    const res = await request(app)
      .get("/v1/accounts/saved_payment_method")
      .set(getAuthHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(true);
    expect(res.body.method).toEqual({ id: "pm_1", type: "card", saved_for: "merchant" });
  });

  it("answers NOT SAVED with the acquirer's reason, as a 200", async () => {
    await insertTestAccount({ orgId });
    ssMocks.getSavedPaymentMethod.mockResolvedValue({
      object: "saved_payment_method",
      org_id: orgId,
      acquirer: "revolut",
      saved: false,
      method: null,
      reason: "no_saved_method",
    });

    const res = await request(app)
      .get("/v1/accounts/saved_payment_method")
      .set(getAuthHeaders(orgId));

    // A definite no is a 200, never an error: the caller renders "add a card".
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(false);
    expect(res.body.reason).toBe("no_saved_method");
    expect(res.body.method).toBeNull();
  });

  it("answers COULD NOT ASK as a 502, never as saved:false", async () => {
    await insertTestAccount({ orgId });
    ssMocks.getSavedPaymentMethod.mockRejectedValue(new Error("timeout"));

    const res = await request(app)
      .get("/v1/accounts/saved_payment_method")
      .set(getAuthHeaders(orgId));

    expect(res.status).toBe(502);
    expect(res.body.saved).toBeUndefined();
  });

  // --- 3. arming automatic top-up on the second acquirer ---

  const onSecondAcquirer = () => ({
    object: "saved_payment_method",
    org_id: orgId,
    acquirer: "revolut",
    saved: false,
    method: null,
    reason: "no_saved_method",
  });

  const armBody = { topup_amount_cents: 5000, topup_threshold_cents: 1000 };

  it("refuses to arm on the second acquirer when the acquirer holds no card", async () => {
    await insertTestAccount({ orgId });
    ssMocks.getSavedPaymentMethod.mockResolvedValue(onSecondAcquirer());
    ssMocks.authorizeRecurringCharges.mockResolvedValue({
      authorized: false,
      reason: "no_saved_payment_method",
    });

    const res = await request(app)
      .patch("/v1/accounts/auto_topup")
      .set(getAuthHeaders(orgId))
      .send(armBody);

    expect(res.status).toBe(400);
    // The legacy Stripe-shape gate must not be what decided this.
    expect(ssMocks.hasAttachedCardPm).not.toHaveBeenCalled();
  });

  it("refuses to arm on the second acquirer when the answer is UNKNOWN", async () => {
    await insertTestAccount({ orgId });
    ssMocks.getSavedPaymentMethod.mockResolvedValue(onSecondAcquirer());
    ssMocks.authorizeRecurringCharges.mockRejectedValue(new Error("acquirer unreachable"));

    const res = await request(app)
      .patch("/v1/accounts/auto_topup")
      .set(getAuthHeaders(orgId))
      .send(armBody);

    // An unknown answer is not a yes.
    expect(res.status).toBe(502);
  });

  it("arms on the second acquirer only once the acquirer authorises it", async () => {
    await insertTestAccount({ orgId });
    ssMocks.getSavedPaymentMethod.mockResolvedValue({
      ...onSecondAcquirer(),
      saved: true,
      method: { id: "pm_1", type: "card", saved_for: "merchant" },
      reason: undefined,
    });
    ssMocks.authorizeRecurringCharges.mockResolvedValue({ authorized: true, details: {} });

    const res = await request(app)
      .patch("/v1/accounts/auto_topup")
      .set(getAuthHeaders(orgId))
      .send(armBody);

    expect(res.status).toBe(200);
    expect(ssMocks.authorizeRecurringCharges).toHaveBeenCalledWith(orgId);
  });

  // --- 4. the first acquirer is untouched ---

  it("arms a first-acquirer org on the legacy gate alone, never the new one", async () => {
    await insertTestAccount({ orgId });
    // Deliberately hostile: the acquirer reports NO saved method, and the
    // recurring-charge authorisation would refuse. Neither may be consulted for
    // an org on the acquirer the legacy gate was written against — a link-only
    // org arms today and must keep arming.
    ssMocks.getSavedPaymentMethod.mockResolvedValue({
      object: "saved_payment_method",
      org_id: orgId,
      acquirer: "stripe",
      saved: false,
      method: null,
      reason: "no_saved_method",
    });
    ssMocks.authorizeRecurringCharges.mockResolvedValue({ authorized: false });
    ssMocks.hasAttachedCardPm.mockResolvedValue(true);

    const res = await request(app)
      .patch("/v1/accounts/auto_topup")
      .set(getAuthHeaders(orgId))
      .send(armBody);

    expect(res.status).toBe(200);
    expect(ssMocks.hasAttachedCardPm).toHaveBeenCalled();
    expect(ssMocks.authorizeRecurringCharges).not.toHaveBeenCalled();
  });

  it("keeps the first acquirer's own refusals exactly as they are", async () => {
    await insertTestAccount({ orgId });
    ssMocks.hasAttachedCardPm.mockResolvedValue(false);

    const noCard = await request(app)
      .patch("/v1/accounts/auto_topup")
      .set(getAuthHeaders(orgId))
      .send(armBody);
    expect(noCard.status).toBe(400);
    expect(noCard.body.error).toContain("Create a checkout session first");

    ssMocks.hasAttachedCardPm.mockResolvedValue(true);
    ssMocks.getOrgCardCountry.mockResolvedValue("IN");

    const blocked = await request(app)
      .patch("/v1/accounts/auto_topup")
      .set(getAuthHeaders(orgId))
      .send(armBody);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toContain("IN");
    expect(ssMocks.authorizeRecurringCharges).not.toHaveBeenCalled();
  });
});
