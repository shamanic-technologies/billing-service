import { afterEach, describe, expect, it, vi } from "vitest";

const body = (orgBasis: string | undefined) =>
  JSON.stringify({ timezone: "UTC", statuses: ["actual", "provisioned"], ...(orgBasis ? { orgBasis } : {}), months: [], orgs: [] });

describe("fetchRunsNoCampaignMonthly", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for spend on the org that incurred it, and accepts that basis", async () => {
    process.env.RUNS_SERVICE_URL = "http://runs.test";
    process.env.RUNS_SERVICE_API_KEY = "k";
    const f = vi.fn(async () => new Response(body("incurred"), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const { fetchRunsNoCampaignMonthly } = await import("../../src/lib/runs-client.js");
    const out = await fetchRunsNoCampaignMonthly();
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain("/internal/stats/costs/no-campaign/monthly?orgBasis=incurred");
    expect(out.orgBasis).toBe("incurred");
  });

  it("refuses an answer on another basis (an older runs-service ignores the parameter)", async () => {
    process.env.RUNS_SERVICE_URL = "http://runs.test";
    process.env.RUNS_SERVICE_API_KEY = "k";
    const { fetchRunsNoCampaignMonthly } = await import("../../src/lib/runs-client.js");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body(undefined), { status: 200 })));
    await expect(fetchRunsNoCampaignMonthly()).rejects.toThrow(/orgBasis=undefined/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body("current"), { status: 200 })));
    await expect(fetchRunsNoCampaignMonthly()).rejects.toThrow(/orgBasis=current/);
  });
});
