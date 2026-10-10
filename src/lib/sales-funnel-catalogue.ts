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
 * Cached per id for a few minutes: a funnel's pipes are a function of its id
 * and the catalogue, and campaign-service asks on every gate tick.
 *
 * Fail-loud: a 404 is `SalesFunnelNotFoundError`, anything else non-2xx or
 * malformed is `SalesFunnelCatalogueUnavailableError`.
 */

import { fetchWithRetry } from "./fetch-retry.js";

export type PipeMode = "proactive" | "reactive";

export interface SalesFunnelPipe {
  /** `<channel slug>|<leg key>`, features-service's pipe id. */
  pipeId: string;
  /** The acquisition channel (a features-service feature slug). */
  channelSlug: string;
  /** The leg in its served spelling. Compare through `sameLeg`, never `===`. */
  legKey: string;
  mode: PipeMode;
}

export type SalesFunnelType = "proactive" | "reactive";

export interface SalesFunnel {
  id: string;
  name: string | null;
  /** Pipes in the funnel's leg order. */
  pipes: SalesFunnelPipe[];
  /**
   * Proactive if at least one pipe is proactive, reactive if all are (owner
   * 2026-10-10). Read from features-service when it serves it (`type`); until
   * then derived from the served pipe modes by that same published rule, and
   * `typeSource` says which. null = the funnel has no pipe at all.
   */
  type: SalesFunnelType | null;
  typeSource: "features_service" | "derived_from_pipe_modes";
}

/**
 * What a funnel's MAX VOLUME counts (served per funnel):
 * - PROACTIVE funnel: `first_contacts`, the first contact its proactive pipes make.
 * - REACTIVE funnel: what its first pipe handles, named by that pipe's to-step
 *   (features-service `toStep`, e.g. `meeting_booked`, label "Meeting booked").
 */
export interface VolumeUnit {
  unit: string;
  unitLabel: string | null;
  /** The pipe whose to-step names a reactive funnel's unit; null on a proactive funnel. */
  pipeId: string | null;
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

const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;
const cache = new Map<string, { at: number; funnel: SalesFunnel }>();

/** Test seam: forget every cached funnel. */
export function __resetSalesFunnelCache(): void {
  cache.clear();
  unitCache.clear();
}

/** PURE: the funnel out of features-service's detail body. Throws on a malformed one. */
export function salesFunnelFromDetail(id: string, body: unknown): SalesFunnel {
  const b = body as { id?: unknown; name?: unknown; legs?: unknown };
  if (!b || typeof b !== "object" || !Array.isArray(b.legs)) {
    throw new SalesFunnelCatalogueUnavailableError(
      `features-service sales funnel ${id} carried no legs array`
    );
  }
  const pipes: SalesFunnelPipe[] = [];
  for (const leg of b.legs as Array<{ pipe?: unknown }>) {
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
    pipes.push({
      pipeId,
      channelSlug: pipeId.slice(0, bar),
      legKey: pipeId.slice(bar + 1),
      mode: pipe.mode,
    });
  }
  const served = typeof (b as { type?: unknown }).type === "string"
    ? String((b as { type: string }).type).toLowerCase()
    : typeof (b as { funnelType?: unknown }).funnelType === "string"
      ? String((b as { funnelType: string }).funnelType).toLowerCase()
      : null;
  if (served !== null && served !== "proactive" && served !== "reactive") {
    throw new SalesFunnelCatalogueUnavailableError(`features-service sales funnel ${id} served an unknown type ${served}`);
  }
  const derived: SalesFunnelType | null =
    pipes.length === 0 ? null : pipes.some((p) => p.mode === "proactive") ? "proactive" : "reactive";
  return {
    id,
    name: typeof b.name === "string" ? b.name : null,
    pipes,
    type: (served as SalesFunnelType | null) ?? derived,
    typeSource: served !== null ? "features_service" : "derived_from_pipe_modes",
  };
}

async function readCatalogue<T>(path: string): Promise<T> {
  const url = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new SalesFunnelCatalogueUnavailableError("FEATURES_SERVICE_URL and FEATURES_SERVICE_API_KEY must be configured");
  }
  const res = await fetchWithRetry(`${url}${path}`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new SalesFunnelCatalogueUnavailableError(`features-service ${path} answered ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

const unitCache = new Map<string, { at: number; unit: VolumeUnit }>();

/**
 * The MAX VOLUME unit of a funnel. A reactive funnel reads its first pipe's
 * to-step (`/internal/catalogue/pipes/:id`) and that step's name
 * (`/internal/catalogue/steps/:id`); cached like the funnel. Throws
 * `SalesFunnelCatalogueUnavailableError` when the step cannot be read.
 */
export async function volumeUnitOf(funnel: SalesFunnel, now: number = Date.now()): Promise<VolumeUnit> {
  if (funnel.type !== "reactive") return { unit: "first_contacts", unitLabel: "First contacts", pipeId: null };
  const first = funnel.pipes[0];
  const hit = unitCache.get(first.pipeId);
  if (hit && now - hit.at < CACHE_MS) return hit.unit;
  const pipe = await readCatalogue<{ toStep?: unknown }>(`/internal/catalogue/pipes/${encodeURIComponent(first.pipeId)}`);
  if (typeof pipe.toStep !== "string" || pipe.toStep === "") {
    throw new SalesFunnelCatalogueUnavailableError(`features-service pipe ${first.pipeId} served no toStep`);
  }
  let label: string | null = null;
  try {
    const step = await readCatalogue<{ name?: unknown }>(`/internal/catalogue/steps/${encodeURIComponent(pipe.toStep)}`);
    label = typeof step.name === "string" ? step.name : null;
  } catch (err) {
    console.error(`[billing-service] step ${pipe.toStep} name unreadable: ${(err as Error).message}`);
  }
  const unit = { unit: pipe.toStep, unitLabel: label, pipeId: first.pipeId };
  unitCache.set(first.pipeId, { at: now, unit });
  return unit;
}

/** One sales funnel and its pipes, from features-service (cached a few minutes). */
export async function getSalesFunnel(id: string, now: number = Date.now()): Promise<SalesFunnel> {
  const hit = cache.get(id);
  if (hit && now - hit.at < CACHE_MS) return hit.funnel;

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
      `features-service sales funnel ${id} unreachable: ${(err as Error).message}`
    );
  }
  if (res.status === 404) throw new SalesFunnelNotFoundError(id);
  if (!res.ok) {
    throw new SalesFunnelCatalogueUnavailableError(
      `features-service sales funnel ${id} answered ${res.status}: ${await res.text()}`
    );
  }
  const funnel = salesFunnelFromDetail(id, await res.json());
  cache.set(id, { at: now, funnel });
  return funnel;
}
