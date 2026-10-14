/**
 * The per-campaign daily ceilings are RETIRED (2026-10-14). A campaign IS a sales
 * funnel campaign: what it may spend is its sales funnel caps. Stage 1 removed
 * every customer route; stage 2 (migration 0088) removed the internal reads and
 * dropped the store once campaign-service, lead-service and features-service
 * were off it in their served builds.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { closeDb } from "../helpers/test-db.js";

const orgId = "00000000-0000-0000-0000-0000000c0e01";
const userId = "00000000-0000-0000-0000-0000000c0e99";
const brandId = "00000000-0000-0000-0000-000000c0eb01";
const offerId = "aaaaaaaa-0e01-4e01-8e01-aaaaaaaaaaaa";
const campaign = "offerId=" + offerId + "&legKey=lead_found_to_conversation&featureSlug=sales-cold-email-outreach";

const app = createTestApp();

describe("per-campaign ceiling routes are retired", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("every /v1 per-campaign and offer-level campaign-budget route answers 404", async () => {
    const auth = getAuthHeaders(orgId, userId);
    for (const [method, path] of [
      ["get", `/v1/brands/${brandId}/campaign-budgets`],
      ["get", `/v1/brands/${brandId}/campaign-budget?${campaign}`],
      ["put", `/v1/brands/${brandId}/campaign-budget`],
      ["get", `/v1/brands/${brandId}/offers/${offerId}/campaign-budgets`],
      ["put", `/v1/brands/${brandId}/offers/${offerId}/campaign-budgets`],
      ["delete", `/v1/brands/${brandId}/offers/${offerId}/campaign-budgets?featureSlug=x&legKey=y`],
      ["get", `/v1/brands/${brandId}/offers/${offerId}/daily-budget`],
      ["get", `/v1/brands/${brandId}/legs/lead_found_to_conversation/daily-budget`],
    ] as const) {
      const res = await request(app)[method](path).set(auth).send({});
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(404);
    }
  });

  it("every internal per-campaign, per-offer and per-leg ceiling read answers 404", async () => {
    const internal = { "X-API-Key": "test-api-key", "x-org-id": orgId };
    for (const path of [
      `/internal/brands/${brandId}/campaign-budgets`,
      `/internal/brands/${brandId}/campaign-budget?${campaign}`,
      `/internal/brands/${brandId}/offers/${offerId}/campaign-budgets`,
      `/internal/brands/${brandId}/offers/${offerId}/daily-budget`,
      `/internal/brands/${brandId}/legs/lead_found_to_conversation/daily-budget`,
    ]) {
      const res = await request(app).get(path).set(internal);
      expect(res.status, `GET ${path}`).toBe(404);
    }
    // The brand's own daily budget and sales budget stay served.
    expect((await request(app).get(`/internal/brands/${brandId}/daily-budget`).set(internal)).status).toBe(200);
    expect((await request(app).get(`/internal/brands/${brandId}/sales-budget`).set(internal)).status).toBe(200);
  });
});
