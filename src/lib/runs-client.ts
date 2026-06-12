/** Client for fetching canonical usage totals from runs-service. */

import { fetchWithRetry } from "./fetch-retry.js";

export interface RunsOrgUsageTotalResult {
  org_id: string;
  spent_cents: string;
  as_of: string;
}

function getRunsServiceConfig() {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

/**
 * Fetch canonical org usage total from runs-service.
 *
 * The runs-service contract owns usage detail. `spent_cents` includes
 * platform costs in `actual` and `provisioned` states, excludes cancelled
 * and org/BYOK costs, and preserves fractional cents as a decimal string.
 */
export async function fetchRunsOrgUsageTotal(
  orgId: string,
  wfHeaders: Record<string, string>
): Promise<RunsOrgUsageTotalResult> {
  const config = getRunsServiceConfig();
  if (!config) {
    throw new Error("RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be configured");
  }

  const res = await fetchWithRetry(
    `${config.url}/internal/org-usage-total?org_id=${encodeURIComponent(orgId)}`,
    {
      headers: {
        "x-api-key": config.apiKey,
        ...wfHeaders,
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `runs-service org-usage-total failed for org ${orgId}: ${res.status} ${body}`
    );
  }

  return (await res.json()) as RunsOrgUsageTotalResult;
}
