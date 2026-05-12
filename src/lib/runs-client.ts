/** Client for fetching expected per-run cost totals from runs-service. */

export interface RunExpectedTotal {
  run_id: string;
  expected_cents: string;
}

export interface RunsExpectedTotalsResult {
  total_expected_cents: string;
  runs: RunExpectedTotal[];
}

function getRunsServiceConfig() {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

/**
 * Fetch expected per-run cost totals (platform actuals on completed/failed runs)
 * for an org. Used by reconcileBillingRuns to detect drift between billing-side
 * confirmed charges and runs-side recorded actuals.
 *
 * Returns null when runs-service is not configured (local dev / unit tests where
 * runs-service is intentionally absent). Callers treat null as "skip reconcile".
 * Network or HTTP errors throw — callers decide whether to swallow per-org.
 */
export async function fetchRunsExpectedTotals(
  orgId: string,
  wfHeaders: Record<string, string>
): Promise<RunsExpectedTotalsResult | null> {
  const config = getRunsServiceConfig();
  if (!config) return null;

  const res = await fetch(
    `${config.url}/internal/runs-expected-totals?org_id=${encodeURIComponent(orgId)}`,
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
      `runs-service runs-expected-totals failed for org ${orgId}: ${res.status} ${body}`
    );
  }

  return (await res.json()) as RunsExpectedTotalsResult;
}
