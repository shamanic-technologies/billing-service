/**
 * The daily minimum a funded ceiling must clear, READ from the acquisition
 * channel's own published commercial terms.
 *
 * WHAT DECIDES A FLOOR. A campaign is (brand, offer, funnel, channel, leg), and
 * what a day of it costs is a property of the CHANNEL: cold email costs what
 * cold email costs, whoever runs it and whatever funnel the leads later travel.
 * So two campaigns on the same channel have the same floor even when their
 * funnels differ — which is exactly what a per-FUNNEL minimum could not express,
 * and why the funnel no longer decides this. The funnel still identifies the
 * ceiling; it just does not price it.
 *
 * WHERE THE FIGURE LIVES. features-service publishes every channel's commercial
 * terms on `GET /public/channels`, including `terms.dailyOperatingCostCents` —
 * the money that channel costs to run for a day. That IS the floor. It is read
 * from there and never copied into a table here: a local copy of another
 * service's list goes stale silently, and this one moves.
 *
 * WHAT AN UNREADABLE CATALOGUE MEANS. It means we do not know the floor, and a
 * gate that cannot be evaluated is a gate that REFUSES — never one that lets
 * money through. So a first read that fails throws, and every budget write
 * refuses with it. A REFRESH that fails keeps serving the last snapshot and logs
 * loudly, because losing a floor we already knew is the one outcome that must
 * not happen; the snapshot is a cache with a minute of life, not a copy of the
 * list.
 *
 * WHAT IS NOT INVENTED. A channel the catalogue does not carry, and a channel
 * whose terms state no daily operating cost, are both refused BY NAME. There is
 * no default minimum: a channel funded at a number nobody chose for it is money
 * already spent, while a refusal is a deploy away from fixed.
 *
 * THIS IS NOT THE PRODUCT TAXONOMY. billing still never asks whether a feature
 * may be SOLD through a funnel — that stays features-service's statement, and
 * nothing here validates the pair.
 */

import { fetchWithRetry } from "./fetch-retry.js";

const CATALOGUE_TIMEOUT_MS = 10_000;

/** How long a read of the published catalogue is reused before re-reading. */
const CATALOGUE_TTL_MS = 60_000;

/** An acquisition channel whose published terms state no daily floor. → 400. */
export class UnknownAcquisitionChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownAcquisitionChannelError";
  }
}

/** The published terms could not be read at all, so no floor is known. → 502. */
export class ChannelTermsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelTermsUnavailableError";
  }
}

/** One channel as the published catalogue states it. Only what we price on. */
export interface PublishedChannel {
  slug?: string | null;
  terms?: { dailyOperatingCostCents?: number | null } | null;
}

/** The floors a write is judged against — one snapshot, read once per write. */
export interface ChannelMinimums {
  /** That channel's floor in cents/day. Throws when it states none. */
  minimumFor(featureSlug: string): number;
  /** True when the published terms state a daily operating cost. */
  prices(featureSlug: string): boolean;
  /** Every priced slug, for a refusal a person can read. */
  slugs(): string[];
}

/**
 * Build the floors from a published catalogue. A channel is priced only when its
 * terms carry a finite, non-negative daily operating cost — 0 is a STATED floor
 * (a channel the customer operates spends none of our money), absent is not.
 */
export function channelMinimumsFrom(
  channels: PublishedChannel[]
): Map<string, number> {
  const minimums = new Map<string, number>();
  for (const channel of channels) {
    const slug = typeof channel?.slug === "string" ? channel.slug.trim() : "";
    if (!slug) continue;
    const cost = channel?.terms?.dailyOperatingCostCents;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) continue;
    minimums.set(slug, cost);
  }
  return minimums;
}

/** Present a resolved map of floors as the snapshot a write is judged against. */
export function channelMinimumsOf(
  minimums: Map<string, number>
): ChannelMinimums {
  return toChannelMinimums(minimums);
}

function toChannelMinimums(minimums: Map<string, number>): ChannelMinimums {
  return {
    minimumFor(featureSlug: string): number {
      const floor = minimums.get(featureSlug);
      if (floor === undefined) {
        throw new UnknownAcquisitionChannelError(
          `Unknown acquisition channel "${featureSlug}" — its published terms state no daily operating cost, ` +
            `so we cannot say what funding it needs to run. Valid channels: ${[...minimums.keys()].sort().join(", ")}.`
        );
      }
      return floor;
    },
    prices(featureSlug: string): boolean {
      return minimums.has(featureSlug);
    },
    slugs(): string[] {
      return [...minimums.keys()].sort();
    },
  };
}

let snapshot: { at: number; minimums: Map<string, number> } | null = null;
let inFlight: Promise<Map<string, number>> | null = null;
/** Set only by the test seam: a seeded catalogue never expires. */
let pinned = false;

async function readPublishedChannels(): Promise<Map<string, number>> {
  const url = process.env.FEATURES_SERVICE_URL;
  if (!url) {
    throw new ChannelTermsUnavailableError(
      "FEATURES_SERVICE_URL is unset, so the acquisition channels' published terms cannot be read " +
        "and no daily minimum can be stated."
    );
  }
  // `/public/channels` carries no identity and needs no api key.
  const res = await fetchWithRetry(`${url}/public/channels`, {
    signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new ChannelTermsUnavailableError(
      `features-service answered ${res.status} for the published acquisition channels.`
    );
  }
  const body = (await res.json()) as { channels?: PublishedChannel[] };
  if (!Array.isArray(body?.channels)) {
    throw new ChannelTermsUnavailableError(
      "features-service returned no channels array for the published acquisition channels."
    );
  }
  const minimums = channelMinimumsFrom(body.channels);
  if (minimums.size === 0) {
    throw new ChannelTermsUnavailableError(
      "features-service published no acquisition channel carrying a daily operating cost."
    );
  }
  return minimums;
}

/**
 * The floors, read from the published catalogue. Reused for a minute; a refresh
 * that fails keeps the last snapshot (loudly), and a FIRST read that fails
 * throws, so a write cannot proceed without a floor.
 */
export async function getChannelMinimums(): Promise<ChannelMinimums> {
  const fresh =
    snapshot !== null &&
    (pinned || Date.now() - snapshot.at < CATALOGUE_TTL_MS);
  if (fresh && snapshot) return toChannelMinimums(snapshot.minimums);

  if (!inFlight) {
    inFlight = readPublishedChannels().finally(() => {
      inFlight = null;
    });
  }

  try {
    const minimums = await inFlight;
    snapshot = { at: Date.now(), minimums };
    return toChannelMinimums(minimums);
  } catch (err) {
    if (snapshot) {
      console.error(
        "[billing-service] could not refresh the acquisition channels' published terms; " +
          "still judging daily minimums against the last snapshot.",
        err
      );
      return toChannelMinimums(snapshot.minimums);
    }
    throw err instanceof ChannelTermsUnavailableError
      ? err
      : new ChannelTermsUnavailableError(
          `The acquisition channels' published terms could not be read: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
  }
}

/** Test seam: seed the snapshot so a suite states its own catalogue. */
export function __primeChannelMinimums(minimums: Map<string, number>): void {
  snapshot = { at: Date.now(), minimums: new Map(minimums) };
  pinned = true;
}

/** Test seam: forget the snapshot, so the next read goes to the catalogue. */
export function __resetChannelMinimums(): void {
  snapshot = null;
  inFlight = null;
  pinned = false;
}
