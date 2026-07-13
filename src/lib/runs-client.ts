/** Client for fetching canonical usage totals from runs-service. */

import { fetchWithRetry } from "./fetch-retry.js";

export interface RunsOrgUsageTotalResult {
  org_id: string;
  /**
   * The NET platform usage (per-org usage discount frozen at cost-write in
   * runs-service). Sourced from the runs `net_spent_cents` field, NOT the gross
   * `spent_cents`. Billing subtracts this verbatim for the spendable balance — the
   * discount is applied exactly once, in runs, so re-applying here would double it.
   * Historical (pre-discount) rows read net == gross in runs, so this is
   * non-retroactive by construction.
   */
  spent_cents: string;
  as_of: string;
}

/** Raw runs-service /internal/org-usage-total body (gross + frozen net). */
interface RunsOrgUsageTotalResponse {
  org_id: string;
  spent_cents: string;
  net_spent_cents: string;
  as_of: string;
}

interface RunsExpectedTotalsResponse {
  total_expected_cents: string;
  net_total_expected_cents: string;
  runs: Array<{
    run_id: string;
    expected_cents: string;
  }>;
}

export interface RunsOrgActualUsageTotalResult {
  /**
   * NET actualized usage (frozen per-row net, COALESCE(net, gross)). Sourced from
   * the runs `net_total_expected_cents` field, NOT the gross `total_expected_cents`.
   * Used for actual_balance_cents / the dashboard "Confirmed charges" line so it
   * agrees with the net spendable balance and the brand Overview.
   */
  spent_cents: string;
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
 * The runs-service contract owns usage detail. The runs body carries both a GROSS
 * `spent_cents` and a frozen NET `net_spent_cents` (per-org usage discount applied
 * once, at cost-write, inside runs). Billing reads the NET figure — the org owes
 * (and is depleted / reloaded against) the discounted amount. Both cover platform
 * costs in `actual` and `provisioned` states, exclude cancelled and org/BYOK costs,
 * and preserve fractional cents as a decimal string. Fail-loud if the net field is
 * absent (a runs-service too old to serve it).
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

  const body = (await res.json()) as RunsOrgUsageTotalResponse;
  if (body.net_spent_cents == null) {
    throw new Error(
      `runs-service org-usage-total missing net_spent_cents for org ${orgId}`
    );
  }
  // Return the NET figure as spent_cents — billing's usage is the discounted amount.
  return { org_id: body.org_id, spent_cents: body.net_spent_cents, as_of: body.as_of };
}

/**
 * Fetch canonical actual-only org usage from runs-service.
 *
 * This excludes provisioned holds, so consumers can display money that has
 * actually been spent without changing `fetchRunsOrgUsageTotal`, which remains
 * the source for authorization/depletion availability. Reads the NET actualized
 * total (`net_total_expected_cents`, frozen per-row net) so actual_balance_cents /
 * the dashboard "Confirmed charges" line is discounted consistently with the net
 * spendable balance. Fail-loud if the net field is absent.
 */
export async function fetchRunsOrgActualUsageTotal(
  orgId: string,
  wfHeaders: Record<string, string>
): Promise<RunsOrgActualUsageTotalResult> {
  const config = getRunsServiceConfig();
  if (!config) {
    throw new Error("RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be configured");
  }

  const res = await fetchWithRetry(
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

  const body = (await res.json()) as RunsExpectedTotalsResponse;
  if (body.net_total_expected_cents == null) {
    throw new Error(
      `runs-service runs-expected-totals missing net_total_expected_cents for org ${orgId}`
    );
  }
  return { spent_cents: body.net_total_expected_cents };
}
