import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchRecurringCampaignStatuses, forgetRecurringStatuses, RECURRING_STATUS_STALE_MAX_MS } from "../../src/lib/campaign-service-client.js";

const ok = (campaigns: unknown[]) => new Response(JSON.stringify({ campaigns }), { status: 200, headers: { "content-type": "application/json" } });

describe("recurring-status stale if error (MIGRATE-1105 S6)", () => {
  beforeEach(() => {
    process.env.CAMPAIGN_SERVICE_URL = "https://campaign.test.local";
    process.env.CAMPAIGN_SERVICE_API_KEY = "k";
    forgetRecurringStatuses();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a failed read serves the org's last good answer for 15 minutes, then the named failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok([{ campaignId: "c1", orgId: "o1" }]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchRecurringCampaignStatuses("o1")).toMatchObject({ ok: true, campaigns: [{ campaignId: "c1" }] });
    fetchMock.mockImplementation(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
    expect(await fetchRecurringCampaignStatuses("o1")).toMatchObject({ ok: true, campaigns: [{ campaignId: "c1" }] });
    // Another org never borrows it.
    expect(await fetchRecurringCampaignStatuses("o2")).toEqual({ ok: false, reason: "campaign_service_unavailable" });
    vi.setSystemTime(new Date(Date.now() + RECURRING_STATUS_STALE_MAX_MS));
    expect(await fetchRecurringCampaignStatuses("o1")).toEqual({ ok: false, reason: "campaign_service_unavailable" });
  });
});
