/**
 * Make every arrival of a LEGACY outbound leg key visible (owner 2026-10-09).
 *
 * The legacy spelling (`start_to_conversation` / `start_to_website_visit` on an
 * outbound channel, lib/leg-identity) is still ACCEPTED everywhere. It is
 * switched off once we MEASURE that nobody sends it: seven days with zero
 * `legacy-outbound-leg-key` lines in this container's log. So every inbound
 * request carrying it writes exactly ONE warn line naming the key(s), the
 * route and the caller. Nothing else changes: this module only reads.
 *
 * Where a leg key arrives, and how its channel is known:
 *   - a body / query object carrying `featureSlug` + `legKey` (any depth: item
 *     lists, the mission-status notification, the campaign-budget query);
 *   - the `?campaigns=featureSlug:legKey,...` query;
 *   - the per-leg path `/brands/:brandId/legs/:legKey/...`, which names NO
 *     channel. There the key is legacy only if it matched a stored row on an
 *     outbound channel, so the route reports it itself (`logLegacyLegKeyOnLegPath`)
 *     after reading the rows: a google-ads `start_to_conversation` logs nothing.
 */
import type { NextFunction, Request, Response } from "express";
import { isLegacyOutboundLegKey } from "./leg-identity.js";

export const LEGACY_OUTBOUND_LEG_KEY_MARKER = "legacy-outbound-leg-key";

export interface LegacyLegKeyArrival {
  featureSlug: string;
  legKey: string;
  /** Where in the request it was found: "body", "query", "query.campaigns", "path". */
  source: string;
}

function pairOf(obj: Record<string, unknown>): { featureSlug: unknown; legKey: unknown } {
  return {
    featureSlug: obj.featureSlug ?? obj.feature_slug,
    legKey: obj.legKey ?? obj.leg_key,
  };
}

function walk(value: unknown, source: string, out: LegacyLegKeyArrival[], depth: number): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, source, out, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  const { featureSlug, legKey } = pairOf(obj);
  if (typeof featureSlug === "string" && typeof legKey === "string" && isLegacyOutboundLegKey(featureSlug.trim(), legKey)) {
    out.push({ featureSlug: featureSlug.trim(), legKey: legKey.trim(), source });
  }
  for (const child of Object.values(obj)) walk(child, source, out, depth + 1);
}

/** Every legacy outbound leg key a request carries in its body or query. Pure. */
export function findLegacyOutboundLegKeys(req: Pick<Request, "body" | "query">): LegacyLegKeyArrival[] {
  const out: LegacyLegKeyArrival[] = [];
  walk(req.body, "body", out, 0);
  walk(req.query, "query", out, 0);
  const campaigns = req.query?.campaigns;
  if (typeof campaigns === "string") {
    for (const part of campaigns.split(",")) {
      const at = part.indexOf(":");
      if (at <= 0) continue;
      const featureSlug = part.slice(0, at).trim();
      const legKey = part.slice(at + 1).trim();
      if (isLegacyOutboundLegKey(featureSlug, legKey)) {
        out.push({ featureSlug, legKey, source: "query.campaigns" });
      }
    }
  }
  return out;
}

function header(req: Request, name: string): string | null {
  const v = req.headers[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** ONE warn line for this request's legacy arrivals; nothing when there are none. */
export function logLegacyOutboundLegKeys(req: Request, arrivals: LegacyLegKeyArrival[]): void {
  if (arrivals.length === 0) return;
  console.warn(
    `[billing-service] ${LEGACY_OUTBOUND_LEG_KEY_MARKER} ` +
      JSON.stringify({
        keys: arrivals,
        route: `${req.method} ${req.path}`,
        callerService: header(req, "x-service-name"),
        orgId: header(req, "x-org-id"),
        userId: header(req, "x-user-id"),
        runId: header(req, "x-run-id"),
      })
  );
}

/** Express middleware: scan body + query once, after JSON parsing. Never blocks. */
export function legacyOutboundLegKeyLogMiddleware(req: Request, _res: Response, next: NextFunction): void {
  try {
    logLegacyOutboundLegKeys(req, findLegacyOutboundLegKeys(req));
  } catch (err) {
    // An observation must never fail the request it observes; say so loudly.
    console.error("[billing-service] legacy leg-key scan failed:", err);
  }
  next();
}

/**
 * The per-leg path names no channel: report its key as legacy only when it is
 * the legacy spelling on a channel of a row it actually matched.
 */
export function logLegacyLegKeyOnLegPath(
  req: Request,
  legKey: string,
  matchedRows: ReadonlyArray<{ featureSlug: string; legKey: string | null }>
): void {
  const hit = matchedRows.find((row) => row.legKey !== null && isLegacyOutboundLegKey(row.featureSlug, legKey));
  if (!hit) return;
  logLegacyOutboundLegKeys(req, [{ featureSlug: hit.featureSlug, legKey: legKey.trim(), source: "path" }]);
}
