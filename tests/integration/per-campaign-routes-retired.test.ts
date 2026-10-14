/**
 * The customer routes to per-campaign daily ceilings are RETIRED (2026-10-14).
 * A campaign IS a sales funnel campaign: what it may spend is its sales funnel
 * caps. The gateway removed every route to these after runs-service showed no
 * caller, so billing no longer serves them either. The internal reads stay until
 * their last service reader moves off.
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

describe("per-campaign ceiling routes are retired from the customer surface", () => {
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
});
