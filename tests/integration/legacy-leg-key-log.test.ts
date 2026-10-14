/**
 * Every arrival of a LEGACY outbound leg key writes ONE warn line carrying the
 * `legacy-outbound-leg-key` marker (lib/legacy-leg-key-log), the signal the
 * switch-off of the legacy spelling waits on. The answer is unchanged; the new
 * spelling and a non-outbound start_to_* log nothing.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { LEGACY_OUTBOUND_LEG_KEY_MARKER } from "../../src/lib/legacy-leg-key-log.js";

const orgId = "00000000-0000-0000-0000-0000000079b1";
const BRAND = "aaaaaaaa-0079-4000-8000-0000000000b1";
const OFFER = "aaaaaaaa-0079-4000-8000-0000000000b2";
const internal = {
  "X-API-Key": "test-api-key",
  "x-org-id": orgId,
  "x-service-name": "features-service",
};
const COLD = "sales-cold-email-outreach";
const app = createTestApp();

function markerLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((c) => c.map(String).join(" "))
    .filter((line) => line.includes(LEGACY_OUTBOUND_LEG_KEY_MARKER));
}

// Any route: the scan is a middleware over every inbound request.
function readCampaign(featureSlug: string, legKey: string) {
  return request(app)
    .get(`/internal/brands/${BRAND}/daily-budget`)
    .query({ offerId: OFFER, legKey, featureSlug })
    .set(internal);
}

describe("legacy outbound leg keys are logged on arrival", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("query: legacy outbound key answers the same and logs ONE marker line naming key, route, caller", async () => {
    const fresh = await readCampaign(COLD, "lead_found_to_conversation");
    const spy = vi.spyOn(console, "warn");
    const legacy = await readCampaign(COLD, "start_to_conversation");
    expect(legacy.status).toBe(fresh.status);
    expect(legacy.body.dailyBudgetCents).toBe(fresh.body.dailyBudgetCents);
    const lines = markerLines(spy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("start_to_conversation");
    expect(lines[0]).toContain(`/internal/brands/${BRAND}/daily-budget`);
    expect(lines[0]).toContain("features-service");
    expect(lines[0]).toContain(orgId);
  });

  it("new spelling and a non-outbound start_to_* log nothing", async () => {
    const spy = vi.spyOn(console, "warn");
    await readCampaign(COLD, "lead_found_to_website_visit");
    await readCampaign("google-ads", "start_to_conversation");
    expect(markerLines(spy)).toHaveLength(0);
  });
});
