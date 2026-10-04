/**
 * What one sales-path ITEM (a channel x leg) requires, READ from features-service's
 * published channel catalogue (`GET /public/channels`), never hard-coded here.
 *
 * Per (channel, leg) the catalogue states:
 *  - `stepTransitions[].minimumMonthlyBudgetCents`: the smallest monthly budget the
 *    item may carry (owner 2026-10-04: $99/month for sales-cold-email-outreach on
 *    start_to_website_visit AND start_to_conversation, $1,500/month for any channel
 *    we do not run yet). A DAILY item (prepaid / postpaid) must clear the same
 *    floor spread over 30 days, rounded up to the cent.
 *  - `stepTransitions[].reactive` (else derived from `from`: null = an ENTRY leg,
 *    proactive, spends daily; a step = a REACTIVE leg, fires when a lead reaches it).
 *  - `operatedBy: "customer"`: a customer-team leg (your-team-*). It carries no
 *    budget at all.
 *  - `managed`: true when we run the channel today. A channel we do not run is
 *    recorded with the card on file and charged NOTHING until it launches.
 *
 * An unreadable catalogue, or an item the catalogue states no minimum / managed
 * flag for, REFUSES the write: a gate that cannot be evaluated never lets money
 * through, and no default floor is invented. A refresh that fails keeps the last
 * snapshot (loudly), like lib/channel-terms.
 */

import { fetchWithRetry } from "./fetch-retry.js";

const CATALOGUE_TIMEOUT_MS = 10_000;
const CATALOGUE_TTL_MS = 60_000;

/** Days a monthly floor is spread over for a daily item. */
export const DAYS_PER_MONTH = 30;

/** The catalogue could not be read, or does not state what an item needs. → 502. */
export class SalesPathTermsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesPathTermsUnavailableError";
  }
}

export type ItemRole = "proactive" | "reactive" | "customer";

/** What billing needs to know about one (channel, leg). */
export interface ItemTerms {
  featureSlug: string;
  legKey: string;
  role: ItemRole;
  /** Smallest monthly budget; null when the catalogue states none. */
  minimumMonthlyCents: number | null;
  /** true when we run the channel today; null when the catalogue states nothing. */
  managed: boolean | null;
}

interface PublishedTransition {
  legKey?: string | null;
  from?: unknown;
  /** features-service's explicit flag; absent → derived from `from`. */
  reactive?: boolean | null;
  minimumMonthlyBudgetCents?: number | null;
}

export interface PublishedSalesChannel {
  slug?: string | null;
  operatedBy?: string | null;
  managed?: boolean | null;
  stepTransitions?: PublishedTransition[] | null;
}

function key(featureSlug: string, legKey: string): string {
  return `${featureSlug}\u0000${legKey}`;
}

/** Index a published catalogue by (channel, leg). Pure. */
export function itemTermsFrom(channels: PublishedSalesChannel[]): Map<string, ItemTerms> {
  const out = new Map<string, ItemTerms>();
  for (const channel of channels) {
    const slug = typeof channel?.slug === "string" ? channel.slug.trim() : "";
    if (!slug) continue;
    const customer = channel.operatedBy === "customer";
    const managed = typeof channel.managed === "boolean" ? channel.managed : null;
    for (const t of channel.stepTransitions ?? []) {
      const legKey = typeof t?.legKey === "string" ? t.legKey.trim() : "";
      if (!legKey) continue;
      const min = t.minimumMonthlyBudgetCents;
      out.set(key(slug, legKey), {
        featureSlug: slug,
        legKey,
        role: customer
          ? "customer"
          : (typeof t.reactive === "boolean" ? t.reactive : t.from != null)
            ? "reactive"
            : "proactive",
        minimumMonthlyCents:
          typeof min === "number" && Number.isFinite(min) && min >= 0 ? Math.round(min) : null,
        managed,
      });
    }
  }
  return out;
}

export interface SalesPathTerms {
  /** The item's terms, or null when the catalogue does not carry the (channel, leg). */
  termsFor(featureSlug: string, legKey: string): ItemTerms | null;
  /** Whether we run this channel today (null = not stated). */
  managedChannel(featureSlug: string): boolean | null;
}

function toTerms(index: Map<string, ItemTerms>): SalesPathTerms {
  return {
    termsFor: (featureSlug, legKey) => index.get(key(featureSlug, legKey)) ?? null,
    managedChannel(featureSlug) {
      for (const t of index.values()) if (t.featureSlug === featureSlug) return t.managed;
      return null;
    },
  };
}

/** Wrap an index as the terms a write is judged against (tests, pure callers). */
export function salesPathTermsOf(index: Map<string, ItemTerms>): SalesPathTerms {
  return toTerms(index);
}

let snapshot: { at: number; index: Map<string, ItemTerms> } | null = null;
let inFlight: Promise<Map<string, ItemTerms>> | null = null;
let pinned = false;

async function readCatalogue(): Promise<Map<string, ItemTerms>> {
  const url = process.env.FEATURES_SERVICE_URL;
  if (!url) {
    throw new SalesPathTermsUnavailableError(
      "FEATURES_SERVICE_URL is unset, so the sales-path item minimums cannot be read."
    );
  }
  const res = await fetchWithRetry(`${url}/public/channels`, {
    signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new SalesPathTermsUnavailableError(
      `features-service answered ${res.status} for the published channels.`
    );
  }
  const body = (await res.json()) as { channels?: PublishedSalesChannel[] };
  if (!Array.isArray(body?.channels)) {
    throw new SalesPathTermsUnavailableError("features-service returned no channels array.");
  }
  return itemTermsFrom(body.channels);
}

/** The terms, read from the published catalogue (reused for a minute). */
export async function getSalesPathTerms(): Promise<SalesPathTerms> {
  if (snapshot && (pinned || Date.now() - snapshot.at < CATALOGUE_TTL_MS)) {
    return toTerms(snapshot.index);
  }
  if (!inFlight) {
    inFlight = readCatalogue().finally(() => {
      inFlight = null;
    });
  }
  try {
    const index = await inFlight;
    snapshot = { at: Date.now(), index };
    return toTerms(index);
  } catch (err) {
    if (snapshot) {
      console.error(
        "[billing-service] could not refresh the sales-path item terms; using the last snapshot.",
        err
      );
      return toTerms(snapshot.index);
    }
    throw err instanceof SalesPathTermsUnavailableError
      ? err
      : new SalesPathTermsUnavailableError(
          `The sales-path item terms could not be read: ${err instanceof Error ? err.message : String(err)}`
        );
  }
}

/** Test seam: state the catalogue a suite runs against (never expires). */
export function __primeSalesPathTerms(channels: PublishedSalesChannel[]): void {
  snapshot = { at: Date.now(), index: itemTermsFrom(channels) };
  pinned = true;
}

/** Test seam: forget the snapshot. */
export function __resetSalesPathTerms(): void {
  snapshot = null;
  inFlight = null;
  pinned = false;
}
