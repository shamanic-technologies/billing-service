/**
 * features-service's outcome catalogue (`GET /public/catalogue/steps`), the two facts the caps
 * read off each outcome (OUTCOME-3WAYS-1121):
 *
 * - `subjectKind` (`person` | `object` | null): what one occurrence is about. A campaign launched
 *   on its TARGET alone whose target is about a PERSON (Paid client, Positive reply, Meeting
 *   booked) reaches people, so its max volume counts the new people it first contacts; a target
 *   about an object (a post, a backlink, a video) counts the outcomes it produced.
 * - `lifecycleRung` + `towardStep`: an outcome about a PERSON on the `contacted` rung (Message
 *   sent, WhatsApp message sent), or one the catalogue states leads to such an outcome (Email
 *   queued -> Email sent: the queue decision, declared when the send is decided, hours before a
 *   throttled mailbox lets it out), is a contact of that person: what "a new person contacted" is
 *   counted by. `towardStep` absent (an older features-service) = only the contacted rung.
 *
 * Read off the catalogue, never a list of outcome keys here. Same freshness rule as the sales
 * path terms (CAPS-READ-FEATURES-DOWN-1024): once read (memory, else the persisted snapshot after
 * a restart) it is served at once and refreshed in the background; only a process that never read
 * it, with nothing persisted, waits on features-service and fails loud.
 */

import { fetchWithRetry } from "./fetch-retry.js";
import { errorReason } from "./pg-error.js";
import { readCatalogueSnapshot, writeCatalogueSnapshot } from "./features-catalogue-snapshots.js";

const TIMEOUT_MS = 10_000;
const TTL_MS = 5 * 60_000;
const SNAPSHOT_KEY = "outcome_steps";

export class OutcomeStepsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutcomeStepsUnavailableError";
  }
}

export interface PublishedOutcomeStep {
  key: string;
  lifecycleRung: string | null;
  subjectKind: string | null;
  /** The outcome this one leads to (features-service `towardStep`); null / absent = none stated. */
  towardStep?: string | null;
}

export interface OutcomeSteps {
  /** The outcome's subject kind; undefined = the catalogue carries no such outcome. */
  subjectKindOf(key: string): string | null | undefined;
  /**
   * The outcomes a contact of a person is declared by: person subject, on the `contacted` rung or
   * leading to an outcome on it (the queue decision before the send).
   */
  contactKeys: string[];
}

/** PURE: the index out of the published rows; throws on a malformed body. */
export function outcomeStepsOf(rows: unknown): OutcomeSteps {
  if (!Array.isArray(rows)) throw new OutcomeStepsUnavailableError("features-service returned no steps rows array.");
  const byKey = new Map<string, PublishedOutcomeStep>();
  for (const r of rows as Array<Record<string, unknown>>) {
    if (typeof r?.key !== "string") throw new OutcomeStepsUnavailableError("features-service returned a step with no key.");
    byKey.set(r.key, {
      key: r.key,
      lifecycleRung: typeof r.lifecycleRung === "string" ? r.lifecycleRung : null,
      subjectKind: typeof r.subjectKind === "string" ? r.subjectKind : null,
      towardStep: typeof r.towardStep === "string" ? r.towardStep : null,
    });
  }
  const contactRung = (key: string | null | undefined) => (key ? byKey.get(key)?.lifecycleRung === "contacted" : false);
  const contactKeys = [...byKey.values()]
    .filter((s) => s.subjectKind === "person" && (contactRung(s.key) || contactRung(s.towardStep)))
    .map((s) => s.key)
    .sort();
  return {
    subjectKindOf: (key) => (byKey.has(key) ? byKey.get(key)!.subjectKind : undefined),
    contactKeys,
  };
}

let snapshot: { at: number; rows: unknown[]; steps: OutcomeSteps } | null = null;
let inFlight: Promise<OutcomeSteps> | null = null;
let pinned = false;

async function readCatalogue(): Promise<{ rows: unknown[]; steps: OutcomeSteps }> {
  const url = process.env.FEATURES_SERVICE_URL;
  if (!url) throw new OutcomeStepsUnavailableError("FEATURES_SERVICE_URL is unset, so the outcome catalogue cannot be read.");
  const res = await fetchWithRetry(`${url}/public/catalogue/steps`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new OutcomeStepsUnavailableError(`features-service answered ${res.status} for the outcome catalogue.`);
  const body = (await res.json()) as { rows?: unknown };
  const steps = outcomeStepsOf(body?.rows);
  const rows = body.rows as unknown[];
  try {
    await writeCatalogueSnapshot(SNAPSHOT_KEY, { rows });
  } catch (err) {
    console.error(`[billing-service] outcome catalogue: snapshot not persisted: ${errorReason(err)}`);
  }
  return { rows, steps };
}

function refresh(): Promise<OutcomeSteps> {
  if (!inFlight) {
    inFlight = readCatalogue()
      .then(({ rows, steps }) => {
        snapshot = { at: Date.now(), rows, steps };
        return steps;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

function refreshInBackground(): void {
  if (inFlight) return;
  refresh().catch((err) => {
    if (snapshot) snapshot = { ...snapshot, at: Date.now() };
    console.error("[billing-service] could not refresh the outcome catalogue; using the last snapshot.", err);
  });
}

/** The outcome catalogue (never awaited once known). */
export async function getOutcomeSteps(): Promise<OutcomeSteps> {
  if (snapshot) {
    if (!pinned && Date.now() - snapshot.at >= TTL_MS) refreshInBackground();
    return snapshot.steps;
  }
  const stored = await readCatalogueSnapshot(SNAPSHOT_KEY);
  if (stored) {
    try {
      const rows = (stored.body as { rows?: unknown[] })?.rows;
      const steps = outcomeStepsOf(rows);
      snapshot = { at: 0, rows: rows!, steps };
      refreshInBackground();
      return steps;
    } catch (err) {
      console.error(`[billing-service] stored outcome catalogue unparseable, asking features-service: ${errorReason(err)}`);
    }
  }
  try {
    return await refresh();
  } catch (err) {
    throw err instanceof OutcomeStepsUnavailableError
      ? err
      : new OutcomeStepsUnavailableError(`The outcome catalogue could not be read: ${errorReason(err)}`);
  }
}

/** Test seam: state the catalogue a suite runs against (never expires). */
export function __primeOutcomeSteps(rows: PublishedOutcomeStep[]): void {
  snapshot = { at: Date.now(), rows, steps: outcomeStepsOf(rows) };
  pinned = true;
}

/** Test seam: forget the snapshot. */
export function __resetOutcomeSteps(): void {
  snapshot = null;
  inFlight = null;
  pinned = false;
}
