/**
 * How much this org has actually been spending per day, lately.
 *
 * WHY THIS IS NOT THE DAILY BUDGET. The configured daily budget is a CEILING —
 * what the customer permitted — and a payment forecast built on it is a
 * forecast of permission rather than of spend. Measured across the twelve orgs
 * that spent anything in the fourteen days to 2026-09-18, utilisation ran from
 * 4% to 146% of the configured total: two orgs were spending MORE than their
 * own ceiling. So the error has no consistent direction and cannot be written
 * off with a caveat; the ceiling is served beside this figure, never instead
 * of it.
 *
 * WHY NOT THE ALL-TIME USAGE TOTAL EITHER. `GET /internal/org-usage-total` is
 * platform-only and correct, and it is undated — an org's lifetime spend says
 * nothing about its rate this fortnight.
 *
 * ⚠️ THE ONE THING THIS READ MUST NOT DO, AND THE REASON IT CAN RETURN NULL.
 * runs-service's dated aggregates count EVERY cost row regardless of who paid
 * the provider, so they include BYOK spend — the org paying its own provider
 * key directly, which billing explicitly never bills. Counting it inflates the
 * burn and predicts a charge date that is too soon. Production at the time of
 * writing: 51,794 BYOK cost rows all-time, ZERO in the last fourteen days — so
 * the filtered and unfiltered readings are identical TODAY and would diverge
 * silently the first time a BYOK org sends again. That divergence is invisible
 * in the response, which is exactly why this file will not paper over it: until
 * runs-service serves a dated PLATFORM-ONLY org spend, the burn is `null` with
 * a named reason and the outlook states plainly that it cannot date a charge.
 * A null a consumer can see beats a number it cannot check.
 *
 * Fail-loud on everything else: a runs-service that is unreachable, slow or
 * answers an unusable shape THROWS. "We could not ask" must never arrive as a
 * burn of zero, which would read as an idle org and suppress a real charge date.
 */

import { Decimal } from "decimal.js";
import { fetchWithRetry } from "./fetch-retry.js";

/** How far back the burn is measured. Stated in the response, not implied. */
export const BURN_WINDOW_DAYS = 14;

const BURN_TIMEOUT_MS = 10_000;

/**
 * Why a burn figure is absent. A named reason, never a bare null — a consumer
 * that cannot tell "we do not know" from "nothing was spent" renders the second
 * one, and the second one is a lie about a paying customer.
 */
export type BurnUnavailableReason =
  /**
   * runs-service does not yet serve a dated, org-scoped, PLATFORM-ONLY spend
   * read, so the only dated figure available would include BYOK. See the
   * warning above; this clears the moment the producer ships the filter.
   */
  | "platform_only_dated_spend_not_served";

export interface RealizedBurn {
  /**
   * Net platform spend per day over the window, as a decimal string in cents.
   * Null when it cannot be measured honestly.
   */
  dailyCents: string | null;
  /** Null when `dailyCents` is non-null. */
  unavailableReason: BurnUnavailableReason | null;
  /** The window this was measured over, in days. */
  windowDays: number;
}

/** One dated bucket of runs-service's cost time-series. */
interface CostTimeseriesBucket {
  period: string;
  netActualCostInUsdCents?: string;
  netProvisionedCostInUsdCents?: string;
}

interface CostTimeseriesResponse {
  buckets?: CostTimeseriesBucket[];
}

function getRunsServiceConfig() {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

/**
 * Whether runs-service can answer the dated PLATFORM-ONLY question yet.
 *
 * Read from the environment rather than probed, because the probe does not
 * exist: an unfiltered answer and a correctly-filtered one are byte-identical
 * for every org with no BYOK history, which today is every active org. So there
 * is no response this service could inspect to tell them apart, and guessing
 * would be the silent fallback this module refuses.
 *
 * Set `RUNS_COST_SOURCE_FILTER` to the query parameter runs-service ships for
 * it (name and value separated by `=`, e.g. `costSource=platform`). Unset, the
 * burn is unavailable and says so.
 */
function getPlatformOnlyFilter(): string | null {
  const raw = process.env.RUNS_COST_SOURCE_FILTER?.trim();
  if (!raw) return null;
  if (!raw.includes("=")) {
    throw new Error(
      `RUNS_COST_SOURCE_FILTER must be a query parameter of the form name=value, got ${JSON.stringify(raw)}`
    );
  }
  return raw;
}

/**
 * The instant the burn window opens, as an ISO string.
 *
 * Exported so the test suite pins the same arithmetic the read uses rather than
 * restating it.
 */
export function burnWindowStart(now: Date, windowDays = BURN_WINDOW_DAYS): string {
  return new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * This org's realized net platform spend per day over the burn window.
 *
 * Throws when runs-service cannot be reached or answers an unusable shape.
 * Returns an explicit unavailable when the platform-only filter is not served.
 */
export async function fetchRealizedDailyBurn(
  orgId: string,
  now: Date
): Promise<RealizedBurn> {
  const filter = getPlatformOnlyFilter();
  if (filter === null) {
    return {
      dailyCents: null,
      unavailableReason: "platform_only_dated_spend_not_served",
      windowDays: BURN_WINDOW_DAYS,
    };
  }

  const config = getRunsServiceConfig();
  if (!config) {
    throw new Error("RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be configured");
  }

  const query = new URLSearchParams({
    interval: "day",
    orgId,
    startedAfter: burnWindowStart(now),
  });

  const res = await fetchWithRetry(
    `${config.url}/v1/stats/public/costs/timeseries?${query.toString()}&${filter}`,
    {
      headers: { "x-api-key": config.apiKey },
      signal: AbortSignal.timeout(BURN_TIMEOUT_MS),
    }
  );

  if (!res.ok) {
    throw new Error(
      `runs-service cost timeseries failed for org ${orgId}: ${res.status} ${await res.text()}`
    );
  }

  const body = (await res.json()) as CostTimeseriesResponse;
  if (!Array.isArray(body?.buckets)) {
    throw new Error(
      `runs-service cost timeseries answered an unusable shape for org ${orgId}`
    );
  }

  // Actual + provisioned, net — the same projected-and-discounted quantity the
  // spendable balance subtracts, so the burn and the balance describe one ledger.
  let total = new Decimal(0);
  for (const bucket of body.buckets) {
    const actual = bucket.netActualCostInUsdCents;
    const provisioned = bucket.netProvisionedCostInUsdCents;
    if (actual == null || provisioned == null) {
      throw new Error(
        `runs-service cost timeseries bucket ${bucket.period} is missing net figures for org ${orgId}`
      );
    }
    total = total.plus(new Decimal(actual)).plus(new Decimal(provisioned));
  }

  return {
    dailyCents: total.dividedBy(BURN_WINDOW_DAYS).toFixed(10),
    unavailableReason: null,
    windowDays: BURN_WINDOW_DAYS,
  };
}
