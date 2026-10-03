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

/**
 * The shortest window a burn is divided by. An org a few hours old would
 * otherwise have its first run extrapolated to a whole day many times over; one
 * day is the smallest window that is still a daily rate.
 */
export const MIN_BURN_WINDOW_DAYS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The window the burn is actually measured over, in (fractional) days: the
 * standard BURN_WINDOW_DAYS, cut short for an org that has not existed that
 * long, and never under MIN_BURN_WINDOW_DAYS.
 *
 * Dividing a young org's spend by fourteen days — most of which it did not
 * exist for — read its burn several times too LOW, which pushed every projected
 * charge and run-out date out by the same factor. Exported so the tests pin the
 * same arithmetic the read uses.
 */
export function effectiveBurnWindowDays(now: Date, orgCreatedAt: Date | null): number {
  if (orgCreatedAt === null) return BURN_WINDOW_DAYS;
  const ageDays = (now.getTime() - orgCreatedAt.getTime()) / DAY_MS;
  return Math.min(BURN_WINDOW_DAYS, Math.max(MIN_BURN_WINDOW_DAYS, ageDays));
}

/**
 * Per-request ceiling on the runs-service read, counted from the moment the
 * request is SENT (after it clears the concurrency gate below), never from when
 * it was queued.
 *
 * Measured 2026-10-03 from inside the billing container, one request at a time:
 * the largest orgs answered in 8.9s, 5.5s and 4.3s on a cold read (the rest in
 * 0.2s to 0.7s). The old 10s ceiling sat right on top of that, so the first
 * fleet-wide read of the morning failed for exactly the orgs that spend most.
 */
export const BURN_TIMEOUT_MS = 25_000;

/**
 * How many burn reads may be in flight against runs-service at once.
 *
 * features-service builds the staff customer-health board (and the owner's
 * morning Telegram) by asking for EVERY org's payment outlook in parallel. Each
 * one became an unbounded concurrent timeseries query, runs-service slowed under
 * the pile-up, and 54 of them hit the 10s ceiling in one morning (bursts of 31
 * and 12 in the same minute). Queuing here keeps each query near its
 * one-at-a-time latency instead of every query sharing the slowest one.
 */
export const BURN_MAX_CONCURRENCY = 4;

let burnInFlight = 0;
const burnQueue: (() => void)[] = [];

/** Run `task` once fewer than BURN_MAX_CONCURRENCY burn reads are in flight. */
async function withBurnSlot<T>(task: () => Promise<T>): Promise<T> {
  if (burnInFlight >= BURN_MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => burnQueue.push(resolve));
  } else {
    burnInFlight += 1;
  }
  try {
    return await task();
  } finally {
    const next = burnQueue.shift();
    // Hand the slot straight to the next waiter (count unchanged) or free it.
    if (next) next();
    else burnInFlight -= 1;
  }
}

/** Test-only view of the gate, so a test can assert the bound actually holds. */
export function __burnGateState(): { inFlight: number; queued: number } {
  return { inFlight: burnInFlight, queued: burnQueue.length };
}

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
  /**
   * The window this was measured over, in days — BURN_WINDOW_DAYS, or shorter
   * (possibly fractional) for an org younger than that.
   */
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
  return new Date(now.getTime() - windowDays * DAY_MS).toISOString();
}

/**
 * This org's realized net platform spend per day over the burn window.
 *
 * Throws when runs-service cannot be reached or answers an unusable shape.
 * Returns an explicit unavailable when the platform-only filter is not served.
 */
export async function fetchRealizedDailyBurn(
  orgId: string,
  now: Date,
  /** When the org's billing account was created; null = assume the full window. */
  orgCreatedAt: Date | null = null
): Promise<RealizedBurn> {
  const windowDays = effectiveBurnWindowDays(now, orgCreatedAt);
  const filter = getPlatformOnlyFilter();
  if (filter === null) {
    return {
      dailyCents: null,
      unavailableReason: "platform_only_dated_spend_not_served",
      windowDays,
    };
  }

  const config = getRunsServiceConfig();
  if (!config) {
    throw new Error("RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be configured");
  }

  const query = new URLSearchParams({
    interval: "day",
    orgId,
    startedAfter: burnWindowStart(now, windowDays),
  });

  // The slot is held until the BODY is read, and the timeout clock starts only
  // once the slot is held: a request waiting its turn is not a slow runs-service.
  const { status, ok, text } = await withBurnSlot(async () => {
    const res = await fetchWithRetry(
      `${config.url}/v1/stats/public/costs/timeseries?${query.toString()}&${filter}`,
      {
        headers: { "x-api-key": config.apiKey },
        signal: AbortSignal.timeout(BURN_TIMEOUT_MS),
      }
    );
    return { status: res.status, ok: res.ok, text: await res.text() };
  });

  if (!ok) {
    throw new Error(`runs-service cost timeseries failed for org ${orgId}: ${status} ${text}`);
  }

  let body: CostTimeseriesResponse;
  try {
    body = JSON.parse(text) as CostTimeseriesResponse;
  } catch {
    throw new Error(
      `runs-service cost timeseries answered non-JSON for org ${orgId}: ${text.slice(0, 200)}`
    );
  }
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
    dailyCents: total.dividedBy(windowDays).toFixed(10),
    unavailableReason: null,
    windowDays,
  };
}
