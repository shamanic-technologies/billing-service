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
 * SOURCE CAMPAIGNS (owner 2026-10-07, features-service v0.179.79): every live
 * sourcing ORIGIN (`GET /public/sourcing-origins`) is a campaign of its own, keyed
 * (offer, featureSlug = <origin slug>, legKey = the published `sourceLegKey`,
 * "start_to_lead_found"). It is an ENTRY leg (proactive), "on demand, up to $X/day":
 * the catalogue publishes NO minimum for it, and the sourcing ceiling it replaces
 * never had one, so its minimum is 0 (a stored budget is still a positive amount;
 * "not set" is a DELETE). `managed` = the origin is live. A retired origin is not
 * indexed: no new budget is stated on it. It never counts as the entry budget a
 * follow-up (reactive) campaign needs: it finds leads, it contacts nobody.
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
  /** true for a SOURCE campaign (a sourcing origin on the published source leg). */
  source: boolean;
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

/** `GET /public/sourcing-origins`, the fields billing reads. */
export interface PublishedSourcingOrigins {
  origins?: Array<{ slug?: string | null; live?: boolean | null }> | null;
  sourceLegKey?: string | null;
  /** outreach channel slug -> the origin slugs that feed it. */
  originsByChannel?: Record<string, string[] | null> | null;
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
        source: false,
      });
    }
  }
  return out;
}

/** Index the LIVE sourcing origins as source campaigns (proactive, minimum 0). Pure. */
export function sourceItemTermsFrom(published: PublishedSourcingOrigins | null | undefined): Map<string, ItemTerms> {
  const out = new Map<string, ItemTerms>();
  const legKey = typeof published?.sourceLegKey === "string" ? published.sourceLegKey.trim() : "";
  if (!legKey) return out;
  for (const origin of published?.origins ?? []) {
    const slug = typeof origin?.slug === "string" ? origin.slug.trim() : "";
    if (!slug || origin.live !== true) continue;
    out.set(key(slug, legKey), {
      featureSlug: slug,
      legKey,
      role: "proactive",
      minimumMonthlyCents: 0,
      managed: true,
      source: true,
    });
  }
  return out;
}

/** The published catalogue billing judges items against. */
export interface TermsIndex {
  items: Map<string, ItemTerms>;
  /** The source leg ("start_to_lead_found"); null when no origin catalogue was read. */
  sourceLegKey: string | null;
  /** outreach channel slug -> the origin slugs that feed it. */
  originsByChannel: Map<string, string[]>;
}

export function termsIndexFrom(
  channels: PublishedSalesChannel[],
  origins: PublishedSourcingOrigins | null = null
): TermsIndex {
  const items = itemTermsFrom(channels);
  for (const [k, t] of sourceItemTermsFrom(origins)) items.set(k, t);
  const originsByChannel = new Map<string, string[]>();
  for (const [channel, slugs] of Object.entries(origins?.originsByChannel ?? {})) {
    if (Array.isArray(slugs)) originsByChannel.set(channel, slugs.filter((s) => typeof s === "string"));
  }
  const legKey = typeof origins?.sourceLegKey === "string" ? origins.sourceLegKey.trim() : "";
  return { items, sourceLegKey: legKey || null, originsByChannel };
}

export interface SalesPathTerms {
  /** The item's terms, or null when the catalogue does not carry the (channel, leg). */
  termsFor(featureSlug: string, legKey: string): ItemTerms | null;
  /** Whether we run this channel today (null = not stated). */
  managedChannel(featureSlug: string): boolean | null;
  /**
   * Is (featureSlug, legKey) a SOURCE campaign? Read off the published source leg and
   * the origin list (a retired origin still answers true: its stored row stays a source).
   */
  isSourceItem(featureSlug: string, legKey: string | null): boolean;
  /** The origin slugs that feed an outreach channel ([] when none). */
  originsFeeding(channelSlug: string): string[];
}

function toTerms(index: TermsIndex): SalesPathTerms {
  const knownOrigins = new Set<string>();
  for (const slugs of index.originsByChannel.values()) for (const s of slugs) knownOrigins.add(s);
  for (const t of index.items.values()) if (t.source) knownOrigins.add(t.featureSlug);
  return {
    termsFor: (featureSlug, legKey) => index.items.get(key(featureSlug, legKey)) ?? null,
    managedChannel(featureSlug) {
      for (const t of index.items.values()) if (t.featureSlug === featureSlug) return t.managed;
      return null;
    },
    isSourceItem: (featureSlug, legKey) =>
      index.sourceLegKey !== null && legKey === index.sourceLegKey && knownOrigins.has(featureSlug),
    originsFeeding: (channelSlug) => index.originsByChannel.get(channelSlug) ?? [],
  };
}

/** Wrap an index as the terms a write is judged against (tests, pure callers). */
export function salesPathTermsOf(
  index: Map<string, ItemTerms>,
  origins: PublishedSourcingOrigins | null = null
): SalesPathTerms {
  const full = termsIndexFrom([], origins);
  for (const [k, t] of index) full.items.set(k, t);
  return toTerms(full);
}

let snapshot: { at: number; index: TermsIndex } | null = null;
let inFlight: Promise<TermsIndex> | null = null;
let pinned = false;

async function readJson<T>(url: string, what: string): Promise<T> {
  const res = await fetchWithRetry(url, { signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS) });
  if (!res.ok) {
    throw new SalesPathTermsUnavailableError(`features-service answered ${res.status} for the ${what}.`);
  }
  return (await res.json()) as T;
}

async function readCatalogue(): Promise<TermsIndex> {
  const url = process.env.FEATURES_SERVICE_URL;
  if (!url) {
    throw new SalesPathTermsUnavailableError(
      "FEATURES_SERVICE_URL is unset, so the sales-path item minimums cannot be read."
    );
  }
  const [body, origins] = await Promise.all([
    readJson<{ channels?: PublishedSalesChannel[] }>(`${url}/public/channels`, "published channels"),
    readJson<PublishedSourcingOrigins>(`${url}/public/sourcing-origins`, "published sourcing origins"),
  ]);
  if (!Array.isArray(body?.channels)) {
    throw new SalesPathTermsUnavailableError("features-service returned no channels array.");
  }
  if (!Array.isArray(origins?.origins) || typeof origins?.sourceLegKey !== "string") {
    throw new SalesPathTermsUnavailableError(
      "features-service returned no sourcing origins (origins[] + sourceLegKey)."
    );
  }
  return termsIndexFrom(body.channels, origins);
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
export function __primeSalesPathTerms(
  channels: PublishedSalesChannel[],
  origins: PublishedSourcingOrigins | null = null
): void {
  snapshot = { at: Date.now(), index: termsIndexFrom(channels, origins) };
  pinned = true;
}

/** Test seam: forget the snapshot. */
export function __resetSalesPathTerms(): void {
  snapshot = null;
  inFlight = null;
  pinned = false;
}
