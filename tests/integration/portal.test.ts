import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

describe("POST /v1/portal-sessions", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("proxies to stripe-service", async () => {
    await insertTestAccount({ orgId });
    ssMocks.createPortalSession.mockResolvedValue({
      url: "https://billing.stripe.com/p/session/abc",
    });

    const res = await request(app)
      .post("/v1/portal-sessions")
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: "https://billing.stripe.com/p/session/abc" });
    expect(ssMocks.createPortalSession).toHaveBeenCalledWith(
      expect.objectContaining({ "x-org-id": orgId }),
      { return_url: "https://example.com/return" }
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
    ssMocks.createPortalSession.mockRejectedValue(new Error("SS down"));

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
