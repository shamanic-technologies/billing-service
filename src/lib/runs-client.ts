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
 * Open a platform-level run and return its id, or null when one cannot be opened.
 *
 * transactional-email-service records every send as a run CHILD of the `x-run-id`
 * it is given, so that header must name a run that actually exists: runs-service
 * rejects the create with `parentRunId <uuid> does not exist` and the email service
 * answers 200 with `{sent: false, reason: "Run creation failed: …"}`. A freshly
 * minted `crypto.randomUUID()` therefore does NOT work — the mail is dropped, and
 * because every send here is fire-and-forget, nothing surfaces it.
 *
 * A platform run is the right shape for a send with no end user behind it (an
 * hourly sweep, a settle): `POST /v1/platform-runs` takes `x-api-key` +
 * `x-service-name` and carries no org, user or parent. It declares NO cost —
 * billing spends nothing to ask another service to send an email, and the email
 * service declares its own.
 *
 * Returns null rather than throwing: every caller is on a fail-soft notification
 * path, and a caller that cannot get a run must skip the send and retry later
 * rather than take a grant down with it.
 */
export async function createPlatformRun(taskName: string): Promise<string | null> {
  const config = getRunsServiceConfig();
  if (!config) {
    console.error(
      "[billing-service] RUNS_SERVICE not configured — cannot open a platform run, notification skipped"
    );
    return null;
  }

  try {
    const res = await fetchWithRetry(`${config.url}/v1/platform-runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "x-service-name": "billing-service",
      },
      body: JSON.stringify({ serviceName: "billing-service", taskName }),
    });

    if (!res.ok) {
      console.error(
        `[billing-service] runs-service platform-run create failed: ${res.status} ${await res.text()}`
      );
      return null;
    }

    const body = (await res.json()) as { id?: string };
    if (!body.id) {
      console.error(
        "[billing-service] runs-service platform-run create returned no id"
      );
      return null;
    }
    return body.id;
  } catch (err) {
    console.error("[billing-service] runs-service platform-run create threw:", err);
    return null;
  }
}

/**
 * Close a platform run opened by `createPlatformRun`.
 *
 * The create ignores any `status` in its body and always stores `running`, so
 * without this every notification would leave a run open forever. Best-effort and
 * silent about its own failure beyond a log: the email has already been dispatched
 * by the time this runs, and a run left open is untidy rather than harmful (these
 * runs declare no cost).
 */
export async function completePlatformRun(runId: string): Promise<void> {
  const config = getRunsServiceConfig();
  if (!config) return;

  try {
    const res = await fetchWithRetry(
      `${config.url}/v1/platform-runs/${encodeURIComponent(runId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "x-service-name": "billing-service",
        },
        body: JSON.stringify({ status: "completed" }),
      }
    );
    if (!res.ok) {
      console.error(
        `[billing-service] runs-service platform-run ${runId} status PATCH failed: ${res.status} ${await res.text()}`
      );
    }
  } catch (err) {
    console.error(
      `[billing-service] runs-service platform-run ${runId} status PATCH threw:`,
      err
    );
  }
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
