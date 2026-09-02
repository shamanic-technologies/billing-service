/**
 * Report, once per boot, every acquisition channel features-service publishes
 * that this service states no daily floor for.
 *
 * WHY THIS EXISTS. `ACQUISITION_CHANNEL_MIN_DAILY_BUDGET_CENTS` is a local copy
 * of another service's list, and it went stale in the way such a copy always
 * does: features-service published a whole family of channels that convert an
 * internal funnel leg, nothing here noticed, and the first thing that noticed
 * was a customer being refused when they tried to fund one. The fail-loud 400 is
 * correct and stays exactly as it is — a channel funded at a number nobody chose
 * for it is money already spent, while a refusal is a deploy away from fixed.
 * What was missing is that nobody learns of the gap until somebody meets it.
 *
 * WHAT IT IS NOT. It resolves nothing, stores nothing, and changes no behaviour:
 * an unpriced slug is still refused, still by name. It is a log line, so the gap
 * is visible on every deploy rather than on a customer's screen.
 *
 * WHY BOOT AND NOT A TEST. A test that reaches the live catalogue makes CI
 * depend on a sibling being up, and one that reads a checked-in copy is a third
 * copy of the same list going stale in the same way. Boot is where the deployed
 * table meets the deployed catalogue, which is the pair the question is about.
 *
 * FAIL-SOFT, and it must stay so: it runs after the port is bound, it is never
 * awaited, and it never throws. An unreachable features-service means we could
 * not audit — logged loudly as exactly that, never as "everything is priced".
 */

import { fetchWithRetry } from "./fetch-retry.js";
import { isKnownAcquisitionChannel } from "./brand-funnel-budgets.js";

const CATALOGUE_TIMEOUT_MS = 10_000;

/** One channel as the published catalogue states it. Only what we audit on. */
export interface PublishedChannel {
  slug: string;
  family?: string | null;
  operatedBy?: string | null;
  terms?: { dailyOperatingCostCents?: number | null } | null;
}

/**
 * The published slugs this service prices no floor for — the set a customer
 * would be refused on. Pure, so the reporting is tested without a network.
 */
export function unpricedChannelSlugs(channels: PublishedChannel[]): string[] {
  return channels
    .map((c) => c.slug)
    .filter((slug) => typeof slug === "string" && slug.length > 0)
    .filter((slug) => !isKnownAcquisitionChannel(slug))
    .sort();
}

/**
 * Read the published catalogue and log the gap. Returns the unpriced slugs, or
 * null when the catalogue could not be read (which is NOT "none unpriced").
 */
export async function auditChannelCoverage(): Promise<string[] | null> {
  const url = process.env.FEATURES_SERVICE_URL;
  if (!url) {
    console.error(
      "[billing-service] channel coverage NOT audited: FEATURES_SERVICE_URL is unset. " +
        "An acquisition channel published since the last deploy would be refused with no warning."
    );
    return null;
  }

  try {
    // `/public/channels` carries no identity and needs no api key.
    const res = await fetchWithRetry(`${url}/public/channels`, {
      signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(
        `[billing-service] channel coverage NOT audited: features-service answered ${res.status}.`
      );
      return null;
    }
    const body = (await res.json()) as { channels?: PublishedChannel[] };
    const channels = body?.channels;
    if (!Array.isArray(channels)) {
      console.error(
        "[billing-service] channel coverage NOT audited: features-service returned no channels array."
      );
      return null;
    }

    const unpriced = unpricedChannelSlugs(channels);
    if (unpriced.length === 0) {
      console.log(
        `[billing-service] channel coverage: all ${channels.length} published acquisition channels are priced.`
      );
      return unpriced;
    }
    console.error(
      `[billing-service] channel coverage GAP: ${unpriced.length} of ${channels.length} published acquisition ` +
        `channels have no daily floor here, so a customer funding one is refused (400). Add them to ` +
        `ACQUISITION_CHANNEL_MIN_DAILY_BUDGET_CENTS: ${unpriced.join(", ")}`
    );
    return unpriced;
  } catch (err) {
    console.error(
      "[billing-service] channel coverage NOT audited: features-service unreachable.",
      err
    );
    return null;
  }
}
