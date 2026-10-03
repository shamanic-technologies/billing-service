import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BURN_MAX_CONCURRENCY,
  BURN_TIMEOUT_MS,
  __burnGateState,
  fetchRealizedDailyBurn,
} from "../../src/lib/realized-burn.js";

/**
 * The fleet board asks for every org's payment outlook at once. Each one reads
 * the realized burn from runs-service; unbounded, 54 of them timed out in one
 * morning (2026-10-03). These pin the gate that keeps that fan-out from piling
 * onto runs-service, and that a failure still fails loud and frees its slot.
 */
describe("realized burn: runs-service concurrency gate", () => {
  const now = new Date(Date.UTC(2026, 9, 3, 12));
  let inFlight = 0;
  let maxInFlight = 0;

  beforeEach(() => {
    process.env.RUNS_COST_SOURCE_FILTER = "costSource=platform";
    process.env.RUNS_SERVICE_URL = "http://runs.test";
    process.env.RUNS_SERVICE_API_KEY = "runs-key";
    inFlight = 0;
    maxInFlight = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RUNS_COST_SOURCE_FILTER;
  });

  function slowFetch(failFor?: string) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      if (failFor && String(input).includes(failFor)) {
        return new Response("boom", { status: 500 });
      }
      return new Response(
        JSON.stringify({
          buckets: [
            { period: "2026-10-02", netActualCostInUsdCents: "1400", netProvisionedCostInUsdCents: "0" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
  }

  it("a fleet-wide fan-out never puts more than the bound in flight, and every read answers", async () => {
    slowFetch();
    const orgs = Array.from({ length: 20 }, (_, i) => `org-${i}`);
    const results = await Promise.all(orgs.map((o) => fetchRealizedDailyBurn(o, now)));

    expect(maxInFlight).toBe(BURN_MAX_CONCURRENCY);
    expect(results.every((r) => r.dailyCents === "100.0000000000")).toBe(true);
    expect(__burnGateState()).toEqual({ inFlight: 0, queued: 0 });
  });

  it("a failing read still fails loud and releases its slot", async () => {
    slowFetch("orgId=org-bad");
    const orgs = ["org-bad", ...Array.from({ length: 9 }, (_, i) => `org-${i}`)];
    const settled = await Promise.allSettled(orgs.map((o) => fetchRealizedDailyBurn(o, now)));

    expect(settled[0].status).toBe("rejected");
    expect(String((settled[0] as PromiseRejectedResult).reason)).toContain("500 boom");
    expect(settled.slice(1).every((s) => s.status === "fulfilled")).toBe(true);
    expect(__burnGateState()).toEqual({ inFlight: 0, queued: 0 });
  });

  it("the timeout covers the measured cold read of the largest org (8.9s)", () => {
    expect(BURN_TIMEOUT_MS).toBeGreaterThan(8_900 * 2);
  });
});
