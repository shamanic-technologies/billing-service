/**
 * A SALES FUNNEL as features-service names and identifies it (owner 2026-10-10).
 *
 * The funnel id is features-service's `combinationKey` (e.g.
 * `lead_found_to_website_visit@sales-cold-email-outreach+website_visit_to_purchase+purchase_to_paid_client`),
 * carried OPAQUE here: billing never parses it. Its pipes are read from
 * `GET /internal/catalogue/sales-funnels/:id` (features-service v0.179.113),
 * each `legs[].pipe` being `{ id: "<channel slug>|<leg key>", mode }` or null on
 * a leg nothing of ours performs. The pipe id's `|` split is that route's
 * published contract, the only thing read out of an id.
 *
 * PLAYS (features-service, owner 2026-10-13): a leg running a non-default play
 * serves its PLAY id, `<channel>|<leg>~<strategy id>`. The strategy is a property
 * of the pipe, never part of its leg: campaign-service stores the unit on the bare
 * leg, so the leg is read up to `~` (else a play's pipe matches no campaign and
 * its spend escapes the cap, Doc Dinners "Catalyze" 2026-10-13).
 *
 * NEVER BLOCKS ON features-service ONCE READ (CAPS-READ-FEATURES-DOWN-1024).
 * A funnel id spells its own structure, so its definition does not move under a
 * given id. Every successful read is kept in memory AND persisted
 * (lib/features-catalogue-snapshots). Fresh in memory (5 min) = served as is;
 * older, or only in the database (after a restart) = served AT ONCE and refreshed
 * in the background (one refresh per id at a time, at most one attempt per 5 min
 * per id while features-service fails). Prod 2026-10-24: the live read on every
 * cache miss timed out while features-service sat at 85% CPU, and campaign-service
 * held two funded clients' whole day (fail-closed).
 *
 * Fail-loud, only for a funnel billing has NEVER read: a 404 is
 * `SalesFunnelNotFoundError`, anything else non-2xx, unreachable or malformed is
 * `SalesFunnelCatalogueUnavailableError` (the caller stays fail-closed).
 */

import { fetchWithRetry } from "./fetch-retry.js";
import { errorReason } from "./pg-error.js";
import { readCatalogueSnapshot, writeCatalogueSnapshot } from "./features-catalogue-snapshots.js";

export type PipeMode = "proactive" | "reactive";

export interface SalesFunnelPipe {
  /** `<channel slug>|<leg key>`, features-service's pipe id. */
  pipeId: string;
  /** The acquisition channel (a features-service feature slug). */
  channelSlug: string;
  /** The leg in its served spelling, WITHOUT any play suffix. Compare through `sameLeg`, never `===`. */
  legKey: string;
  /** The play's strategy when the funnel names a non-default play on this pipe; null = the default play. */
  strategyId: string | null;
  mode: PipeMode;
  /**
   * The step this pipe's leg PRODUCES (the detail's `legs[].toStep`: `email_sent`,
   * `meeting_booked`); null when not served. The caps measure a volume by it
   * (lib/sales-funnel-caps `itemTaskOf`). Read off the funnel itself, so a leg the
   * channel catalogue no longer publishes still carries it.
   */
  toStep: string | null;
  /**
   * Whether WE run this pipe's channel (the leg's `channels[].runByUs` for this channel):
   * false = the customer's own team (`your-team-*`), never a pipe the caps count; null /
   * absent = not served.
   */
  runByUs?: boolean | null;
}

/**
 * The funnel's TYPE as features-service SERVES it (`type` on the detail,
 * features-service `funnelTypeOf`, owner 2026-10-10): `proactive` when at least
 * one pipe is proactive, else `reactive`. RELAYED, never derived here from pipe
 * modes: null when features-service does not serve it (older version).
 */
export type SalesFunnelType = "proactive" | "reactive";

export interface SalesFunnel {
  id: string;
  name: string | null;
  /** features-service's served type; null = not served (never computed here). */
  type: SalesFunnelType | null;
  pipes: SalesFunnelPipe[];
  /**
   * The trigger a REACTIVE funnel fires on (the detail's `trigger.slug`:
   * `email_pushed_via_api`, `positive_reply_received`); null when not served.
   */
  triggerSlug: string | null;
  /** The trigger's served display name (`trigger.name`: "Positive reply"); null/absent when not served. */
  triggerName?: string | null;
}

export class SalesFunnelNotFoundError extends Error {
  constructor(public readonly salesFunnelId: string) {
    super(`features-service knows no sales funnel ${salesFunnelId}`);
    this.name = "SalesFunnelNotFoundError";
  }
}

export class SalesFunnelCatalogueUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesFunnelCatalogueUnavailableError";
  }
}

/** features-service's play separator (`<pipe id>~<strategy id>`, its `PLAY_SEPARATOR`). */
const PLAY_SEPARATOR = "~";

const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;
/** `at` = when the funnel was last confirmed by features-service, or last refresh ATTEMPT. */
const cache = new Map<string, { at: number; funnel: SalesFunnel }>();
const inFlight = new Map<string, Promise<SalesFunnel>>();

/** Test seam: forget every funnel held in MEMORY (the database snapshot stays, like a restart). */
export function __resetSalesFunnelCache(): void {
  cache.clear();
  inFlight.clear();
}

const snapshotKey = (id: string) => `sales_funnel:${id}`;

/** PURE: the leg's served `runByUs` for one channel; no key when not served. */
function runByUsOf(channels: unknown, channelSlug: string): { runByUs?: boolean } {
  if (!Array.isArray(channels)) return {};
  const c = channels.find((x) => (x as { id?: unknown })?.id === channelSlug) as { runByUs?: unknown } | undefined;
  return typeof c?.runByUs === "boolean" ? { runByUs: c.runByUs } : {};
}

/** PURE: the funnel out of features-service's detail body. Throws on a malformed one. */
export function salesFunnelFromDetail(id: string, body: unknown): SalesFunnel {
  const b = body as { id?: unknown; name?: unknown; type?: unknown; legs?: unknown; trigger?: { slug?: unknown; name?: unknown } | null };
  if (!b || typeof b !== "object" || !Array.isArray(b.legs)) {
    throw new SalesFunnelCatalogueUnavailableError(
      `features-service sales funnel ${id} carried no legs array`
    );
  }
  const pipes: SalesFunnelPipe[] = [];
  for (const leg of b.legs as Array<{ pipe?: unknown; toStep?: unknown; channels?: unknown }>) {
    const pipe = leg?.pipe as { id?: unknown; mode?: unknown } | null | undefined;
    if (pipe == null) continue;
    const pipeId = typeof pipe.id === "string" ? pipe.id : null;
    const bar = pipeId ? pipeId.indexOf("|") : -1;
    if (!pipeId || bar <= 0 || bar === pipeId.length - 1) {
      throw new SalesFunnelCatalogueUnavailableError(
        `features-service sales funnel ${id} carried a pipe without a <channel>|<leg> id: ${JSON.stringify(pipe.id)}`
      );
    }
    if (pipe.mode !== "proactive" && pipe.mode !== "reactive") {
      throw new SalesFunnelCatalogueUnavailableError(
        `features-service sales funnel ${id} pipe ${pipeId} carried no proactive|reactive mode`
      );
    }
    const legPart = pipeId.slice(bar + 1);
    const tilde = legPart.indexOf(PLAY_SEPARATOR);
    const legKey = tilde < 0 ? legPart : legPart.slice(0, tilde);
    if (!legKey) {
      throw new SalesFunnelCatalogueUnavailableError(
        `features-service sales funnel ${id} carried a pipe without a leg: ${JSON.stringify(pipe.id)}`
      );
    }
    pipes.push({
      pipeId,
      channelSlug: pipeId.slice(0, bar),
      legKey,
      strategyId: tilde < 0 ? null : legPart.slice(tilde + 1) || null,
      mode: pipe.mode,
      toStep: typeof leg.toStep === "string" && leg.toStep.trim() ? leg.toStep.trim() : null,
      ...runByUsOf(leg.channels, pipeId.slice(0, bar)),
    });
  }
  const type = b.type === "proactive" || b.type === "reactive" ? b.type : null;
  const trigger = typeof b.trigger?.slug === "string" && b.trigger.slug.trim() ? b.trigger.slug.trim() : null;
  const triggerName = typeof b.trigger?.name === "string" && b.trigger.name.trim() ? b.trigger.name.trim() : null;
  return { id, name: typeof b.name === "string" ? b.name : null, type, pipes, triggerSlug: trigger, triggerName };
}

/**
 * One sales funnel and its pipes. Served from memory or the persisted snapshot
 * whenever billing has read it once (refreshed in the background); asked live,
 * and awaited, only the first time.
 */
export async function getSalesFunnel(id: string, now: number = Date.now()): Promise<SalesFunnel> {
  const hit = cache.get(id);
  if (hit && now - hit.at < CACHE_MS) return hit.funnel;
  if (hit) {
    refreshInBackground(id, now);
    return hit.funnel;
  }
  const stored = await storedFunnel(id);
  if (stored) {
    // at 0: the snapshot is refreshed now, in the background.
    cache.set(id, { at: 0, funnel: stored });
    refreshInBackground(id, now);
    return stored;
  }
  return fetchOnce(id);
}

/** The persisted funnel, or null (none, or a body this code can no longer parse). */
async function storedFunnel(id: string): Promise<SalesFunnel | null> {
  const snap = await readCatalogueSnapshot(snapshotKey(id));
  if (!snap) return null;
  try {
    return salesFunnelFromDetail(id, snap.body);
  } catch (err) {
    console.error(`[billing-service] stored sales funnel ${id} unparseable, asking features-service: ${errorReason(err)}`);
    return null;
  }
}

function refreshInBackground(id: string, now: number): void {
  if (inFlight.has(id)) return;
  fetchOnce(id).catch((err) => {
    // Keep serving the known funnel; next attempt in CACHE_MS (never hammer a struggling features-service).
    const known = cache.get(id);
    if (known) cache.set(id, { at: now, funnel: known.funnel });
    console.error(`[billing-service] sales funnel ${id}: background refresh failed, serving the last known definition: ${errorReason(err)}`);
  });
}

/** One live read per id at a time; a success lands in memory and in the snapshot. */
function fetchOnce(id: string): Promise<SalesFunnel> {
  const pending = inFlight.get(id);
  if (pending) return pending;
  const p = fetchFromFeatures(id).finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return p;
}

async function fetchFromFeatures(id: string): Promise<SalesFunnel> {
  const url = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new SalesFunnelCatalogueUnavailableError(
      "FEATURES_SERVICE_URL and FEATURES_SERVICE_API_KEY must be configured to read a sales funnel"
    );
  }
  let res: Response;
  try {
    res = await fetchWithRetry(
      `${url}/internal/catalogue/sales-funnels/${encodeURIComponent(id)}`,
      { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
  } catch (err) {
    throw new SalesFunnelCatalogueUnavailableError(
      `features-service sales funnel ${id} unreachable: ${errorReason(err)}`
    );
  }
  if (res.status === 404) throw new SalesFunnelNotFoundError(id);
  if (!res.ok) {
    throw new SalesFunnelCatalogueUnavailableError(
      `features-service sales funnel ${id} answered ${res.status}: ${await res.text()}`
    );
  }
  const body: unknown = await res.json();
  const funnel = salesFunnelFromDetail(id, body);
  cache.set(id, { at: Date.now(), funnel });
  try {
    await writeCatalogueSnapshot(snapshotKey(id), body);
  } catch (err) {
    // The answer is in hand: a failed persist costs only the restart case, logged loud.
    console.error(`[billing-service] sales funnel ${id}: snapshot not persisted: ${errorReason(err)}`);
  }
  return funnel;
}
