import { describe, it, expect, vi, afterEach } from "vitest";
import * as fetchRetry from "../../src/lib/fetch-retry.js";
import {
  fetchRunsOrgUsageTotal,
  fetchRunsOrgActualUsageTotal,
} from "../../src/lib/runs-client.js";

const ORG = "5fefaf5a-8d50-4c5f-aa4b-3d35bcd1de93";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("runs-client reads NET usage (per-org usage discount frozen in runs)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fetchRunsOrgUsageTotal returns net_spent_cents, NOT gross spent_cents", async () => {
    // Mid-history discount: gross = pre-discount + post-discount (undiscounted);
    // net = pre-discount (net == gross) + post-discount * (1 − pct). runs freezes
    // the per-row net at cost-write, so the two totals diverge only over discounted
    // rows and pre-discount usage stays at full price (non-retroactive).
    const spy = vi
      .spyOn(fetchRetry, "fetchWithRetry")
      .mockResolvedValue(
        jsonResponse({
          org_id: ORG,
          spent_cents: "6540.0330618610", // GROSS — must NOT be used
          net_spent_cents: "5315.7879745674", // NET — must be used
          as_of: "2026-07-13T00:00:00.000Z",
        })
      );

    const result = await fetchRunsOrgUsageTotal(ORG, {});

    expect(result.spent_cents).toBe("5315.7879745674");
    expect(result.spent_cents).not.toBe("6540.0330618610");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("/internal/org-usage-total?org_id="),
      expect.anything()
    );
  });

  it("fetchRunsOrgUsageTotal fails loud when net_spent_cents is absent", async () => {
    vi.spyOn(fetchRetry, "fetchWithRetry").mockResolvedValue(
      jsonResponse({
        org_id: ORG,
        spent_cents: "6540.0330618610",
        as_of: "2026-07-13T00:00:00.000Z",
      })
    );

    await expect(fetchRunsOrgUsageTotal(ORG, {})).rejects.toThrow(
      /missing net_spent_cents/
    );
  });

  it("fetchRunsOrgActualUsageTotal returns net_total_expected_cents, NOT gross", async () => {
    vi.spyOn(fetchRetry, "fetchWithRetry").mockResolvedValue(
      jsonResponse({
        total_expected_cents: "3324.0849137504", // GROSS actualized — must NOT be used
        net_total_expected_cents: "2783.9414137504", // NET actualized — must be used
        runs: [],
      })
    );

    const result = await fetchRunsOrgActualUsageTotal(ORG, {});

    expect(result.spent_cents).toBe("2783.9414137504");
    expect(result.spent_cents).not.toBe("3324.0849137504");
  });

  it("fetchRunsOrgActualUsageTotal fails loud when net_total_expected_cents is absent", async () => {
    vi.spyOn(fetchRetry, "fetchWithRetry").mockResolvedValue(
      jsonResponse({
        total_expected_cents: "3324.0849137504",
        runs: [],
      })
    );

    await expect(fetchRunsOrgActualUsageTotal(ORG, {})).rejects.toThrow(
      /missing net_total_expected_cents/
    );
  });
});
