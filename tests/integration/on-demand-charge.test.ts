/**
 * On-demand off-session charge (`POST /internal/accounts/by-org/:orgId/charge`).
 *
 * The rebuilt sell-first onboarding pays funnel 1 through hosted Checkout
 * (which saves the card) and funnels 2..N one call at a time here. The pins:
 * a success charges the stated amount through the existing reload path
 * (mirrored → credited rises like an ordinary topup), and every non-success
 * is DISTINGUISHABLE on the wire — a decline is never a silent no-op, never a
 * generic 502, so the dashboard can fall back to hosted checkout exactly on
 * the card failures and treat upstream errors as "try again".
 *
 * Own file (one describe per file — see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { insertTestAccount, cleanTestData, closeDb } from "../helpers/test-db.js";
import * as runsClient from "../../src/lib/runs-client.js";

const app = createTestApp();
const orgId = "00000000-0000-0000-0000-0000000000e1";
const PATH = `/internal/accounts/by-org/${orgId}/charge`;

describe("POST /internal/accounts/by-org/:orgId/charge", () => {
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
    // A billing account row exists so the balance read (and the balance
    // composition inside the charge) resolve this org.
    await insertTestAccount({ orgId });
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("5000.0000000000");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(
      async (org: string) => ({
        org_id: org,
        spent_cents: "0.0000000000",
        as_of: "2026-09-15T00:00:00.000Z",
      })
    );
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(
      async (org: string) => ({
        org_id: org,
        spent_cents: "0.0000000000",
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("charges the stated amount off-session and reports success with a reference", async () => {
    const res = await request(app)
      .post(PATH)
      .set(getAuthHeaders(orgId))
      .send({ amountCents: 5000 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      charged: true,
      amountCents: 5000,
      reference: "pi_mock",
    });
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    const [chargedOrg, chargedCents, _key, metadata] =
      ssMocks.reloadOffSession.mock.calls[0];
    expect(chargedOrg).toBe(orgId);
    expect(chargedCents).toBe(5000);
    expect(metadata).toEqual({ reason: "on_demand_topup" });
  });

  it("credits the balance like an ordinary topup (credited rises via the mirrored topup)", async () => {
    // The success path mirrors the charge in stripe-service, so the next
    // balance composition reads it as a paid topup. Simulate the pre-charge
    // state: credited $50 (the amount we are about to charge is already in
    // the sum after the mirror), usage $20 → balance $30.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("5000.0000000000");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(
      async (org: string) => ({
        org_id: org,
        spent_cents: "2000.0000000000",
        as_of: "2026-09-15T00:00:00.000Z",
      })
    );

    const res = await request(app)
      .post(PATH)
      .set(getAuthHeaders(orgId))
      .send({ amountCents: 5000 });

    expect(res.status).toBe(200);
    expect(res.body.charged).toBe(true);

    // The balance read the gateway already uses must reflect the charge.
    const balanceRes = await request(app)
      .get(`/internal/accounts/by-org/${orgId}/balance`)
      .set(getAuthHeaders(orgId));
    expect(balanceRes.status).toBe(200);
    expect(balanceRes.body.balance_cents).toBe("3000.0000000000");
  });

  it("forwards a caller-supplied idempotency key verbatim (retry collapses, no double charge)", async () => {
    const res = await request(app)
      .post(PATH)
      .set(getAuthHeaders(orgId))
      .send({ amountCents: 5000, idempotencyKey: "funnel-2-payment-1" });

    expect(res.status).toBe(200);
    const [, , forwardedKey] = ssMocks.reloadOffSession.mock.calls[0];
    expect(forwardedKey).toBe("funnel-2-payment-1");
  });

  it("402 charge_declined when the card declines — distinguishable from success and from outages", async () => {
    ssMocks.reloadOffSession.mockRejectedValue(
      new Error(
        "stripe-service POST /internal/charges/by-org/x failed: 402 card_declined"
      )
    );

    const res = await request(app)
      .post(PATH)
      .set(getAuthHeaders(orgId))
      .send({ amountCents: 5000 });

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      ok: false,
      charged: false,
      code: "charge_declined",
    });
  });

  it("402 charge_declined when the charge settles as failed (no throw path)", async () => {
    ssMocks.reloadOffSession.mockResolvedValue({
      status: "failed",
      failure_reason: "charge.status=failed",
    });

    const res = await request(app)
      .post(PATH)
      .set(getAuthHeaders(orgId))
      .send({ amountCents: 5000 });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("charge_declined");
  });

  it("409 no_chargeable_payment_method when no chargeable saved card exists — fails clearly, no charge attempted", async () => {
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);

    const res = await request(app)
      .post(PATH)
      .set(getAuthHeaders(orgId))
      .send({ amountCents: 5000 });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      ok: false,
      charged: false,
      code: "no_chargeable_payment_method",
    });
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("409 card_not_chargeable_off_session for an off_session-blocked issuing country", async () => {
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("IN");

    const res = await request(app)
      .post(PATH)
      .set(getAuthHeaders(orgId))
      .send({ amountCents: 5000 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("card_not_chargeable_off_session");
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("429 charge_backoff when the org is in reload backoff — a recent decline is not hammered", async () => {
    ssMocks.reloadOffSession.mockResolvedValue({
      status: "failed",
      backoffSkipped: true,
      failure_reason: "reload_backoff: 1 consecutive failures, retry in 299s",
    });

    const res = await request(app)
      .post(PATH)
      .set(getAuthHeaders(orgId))
      .send({ amountCents: 5000 });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe("charge_backoff");
    expect(res.body.charged).toBe(false);
  });

  it("502 upstream_error when stripe-service could not be asked — NOT reported as a decline", async () => {
    ssMocks.reloadOffSession.mockRejectedValue(
      new Error(
        "stripe-service POST /internal/charges/by-org/x failed: 500 boom"
      )
    );

    const res = await request(app)
      .post(PATH)
      .set(getAuthHeaders(orgId))
      .send({ amountCents: 5000 });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("upstream_error");
    expect(res.body.charged).toBe(false);
  });

  it("400 on a sub-minimum amount (Stripe rejects it) — refused before any charge attempt", async () => {
    const res = await request(app)
      .post(PATH)
      .set(getAuthHeaders(orgId))
      .send({ amountCents: 20 });

    expect(res.status).toBe(400);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("400 on a bad body", async () => {
    const res = await request(app)
      .post(PATH)
      .set(getAuthHeaders(orgId))
      .send({});

    expect(res.status).toBe(400);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("400 on a non-UUID orgId", async () => {
    const res = await request(app)
      .post("/internal/accounts/by-org/not-a-uuid/charge")
      .set(getAuthHeaders())
      .send({ amountCents: 5000 });

    expect(res.status).toBe(400);
  });
});
