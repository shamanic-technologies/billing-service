import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import * as runsClient from "../../src/lib/runs-client.js";

describe("POST /v1/portal-sessions", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    // The route now settles any outstanding balance before opening a session, so
    // it composes a balance — these cases sit at 0 (paid 0, used 0) and take the
    // "nothing owed" branch, which is the pre-settlement behaviour verbatim.
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(
      async (org: string) => ({
        org_id: org,
        spent_cents: "0.0000000000",
        as_of: "2026-01-31T00:00:00.000Z",
      })
    );
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("passes stripe-service's card-setup description straight through", async () => {
    await insertTestAccount({ orgId });

    const res = await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    expect(res.status).toBe(200);
    // `url` is still exactly where it always was for the hosted case, so a
    // client that only reads `url` keeps working.
    expect(res.body.url).toBe("https://billing.stripe.com/p/session/abc");
    expect(res.body.mode).toBe("hosted_redirect");
    expect(ssMocks.getCardSetup).toHaveBeenCalledWith(
      orgId,
      "https://example.com/return",
      undefined,
      undefined
    );
  });

  it("passes an embedded-widget description through without interpreting it", async () => {
    // Not every acquirer has a portal. This repo must not flatten the two
    // mechanisms into one, nor name the vendor behind either.
    await insertTestAccount({ orgId });
    ssMocks.getCardSetup.mockResolvedValue({
      object: "card_setup",
      mode: "embedded_widget",
      public_key: "pk_test",
      token: "tok_1",
      save_payment_method_for: "merchant",
    });

    const res = await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      object: "card_setup",
      mode: "embedded_widget",
      public_key: "pk_test",
      token: "tok_1",
      save_payment_method_for: "merchant",
    });
  });

  it("passes a top-up amount through, for a provider that saves a card only with a payment", async () => {
    await insertTestAccount({ orgId });

    await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        return_url: "https://example.com/return",
        amount: 50000,
        currency: "USD",
      });

    expect(ssMocks.getCardSetup).toHaveBeenCalledWith(
      orgId,
      "https://example.com/return",
      50000,
      "USD"
    );
  });

  it("returns 404 when billing account doesn't exist", async () => {
    const res = await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    expect(res.status).toBe(404);
  });

  it("returns 502 when stripe-service fails", async () => {
    await insertTestAccount({ orgId });
    ssMocks.getCardSetup.mockRejectedValue(new Error("SS down"));

    const res = await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    expect(res.status).toBe(502);
  });

  it("returns 400 for invalid request body", async () => {
    await insertTestAccount({ orgId });

    const res = await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({});

    expect(res.status).toBe(400);
  });
});
