/**
 * A campaign's budget in TWO parts: the OUTREACH it pays every day, and the
 * SOURCING that feeds it leads, "on demand, up to $X/day".
 *
 * One row per campaign already exists (`campaign_daily_budgets`); the split is
 * one more column on it, never a second store on the same grain (owner rule):
 *
 *   daily_budget_cents      = the campaign's MAX daily spend (unchanged meaning,
 *                             every existing reader keeps reading it)
 *   sourcing_ceiling_cents  = the part of it sourcing may spend, a CEILING
 *   outreach                = daily_budget_cents - sourcing_ceiling_cents (served,
 *                             never stored, so the two parts always add up)
 *
 * NULL = never split: the whole chain is paid out of one budget, exactly as
 * before (outreach is then served as the whole amount and sourcing as null).
 *
 * WHAT IS SOURCING. Measured, never declared by a cost-name list: the whole cost
 * subtree of every `lead-service:lead-serve` run (one per served lead) and every
 * `apollo-service:audience-companies` run (list building). Every descendant of
 * those runs carries the campaign id (prod 2026-10-07: 130,244 descendants over
 * 30 days, 0 without), so a campaign's sourcing spend is that subtree under its
 * campaign ids and its outreach spend is the rest. Basis: committed NET
 * (actual + provisioned, frozen per-row discount), the basis campaign-service
 * already paces on. A ceiling is never discounted.
 *
 * A WRITE THAT MOVES THE TOTAL WITHOUT STATING THE SPLIT KEEPS ITS SHARE
 * (`scaledSourcingCeilingSql`): sourcing = old sourcing x new total / old total,
 * so a campaign raised from $20 (sourcing up to $9) to $40 sources up to $18.
 * A row whose total was 0 has no share left to keep and goes back to unsplit.
 *
 * Fail-loud: a runs-service read that fails throws (502 upstream), never a spend
 * of zero (a zero would let a gate overspend).
 */

import { Decimal } from "decimal.js";
import { sql, type SQL } from "drizzle-orm";
import type { CeilingRow } from "../db/schema.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { currentUtcDay, formatUtcDay } from "./utc-day.js";

/** The sourcing subtree roots, as (serviceName, taskName). */
export const SOURCING_ROOT_TASKS: ReadonlyArray<{ serviceName: string; taskName: string }> = [
  { serviceName: "lead-service", taskName: "lead-serve" },
  { serviceName: "apollo-service", taskName: "audience-companies" },
];

const SCALE = 10;

function fixed(value: Decimal): string {
  return value.toFixed(SCALE);
}

/** A malformed or impossible split. Surfaced as a 400. */
export class InvalidSourcingCeilingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSourcingCeilingError";
  }
}

/** One campaign's two parts, as served. */
export interface CampaignSplit {
  /** The campaign's max daily spend = outreach + sourcing ceiling. */
  dailyBudgetCents: string;
  /** What outreach may spend per day (the whole amount when unsplit). */
  outreachDailyBudgetCents: string;
  /** What sourcing may spend per day, on demand. null = not split. */
  sourcingCeilingCents: string | null;
  split: boolean;
}

/**
 * The split of a set of rows that ARE one campaign's money (usually one). Split
 * only when every row states one: a half-split campaign has no honest ceiling.
 */
export function splitOf(rows: Array<Pick<CeilingRow, "dailyBudgetCents" | "sourcingCeilingCents">>): CampaignSplit {
  let total = new Decimal(0);
  let sourcing = new Decimal(0);
  let split = rows.length > 0;
  for (const row of rows) {
    total = total.plus(row.dailyBudgetCents);
    if (row.sourcingCeilingCents === null) split = false;
    else sourcing = sourcing.plus(row.sourcingCeilingCents);
  }
  return {
    dailyBudgetCents: fixed(total),
    outreachDailyBudgetCents: fixed(split ? total.minus(sourcing) : total),
    sourcingCeilingCents: split ? fixed(sourcing) : null,
    split,
  };
}

/**
 * Validate a stated sourcing ceiling against the campaign's total. `null` clears
 * the split; anything else must be a non-negative amount no larger than the total.
 */
export function parseSourcingCeiling(input: unknown, dailyBudgetCents: string): string | null {
  if (input === null) return null;
  const raw = typeof input === "number" || typeof input === "string" ? String(input).trim() : "";
  let value: Decimal;
  try {
    value = new Decimal(raw);
  } catch {
    throw new InvalidSourcingCeilingError("sourcingCeilingCents must be a number of cents or null.");
  }
  if (!raw || !value.isFinite() || value.isNegative()) {
    throw new InvalidSourcingCeilingError("sourcingCeilingCents must be a non-negative number of cents or null.");
  }
  if (value.greaterThan(dailyBudgetCents)) {
    throw new InvalidSourcingCeilingError(
      `sourcingCeilingCents (${value.toString()}) cannot exceed the campaign's daily budget (${new Decimal(dailyBudgetCents).toString()}): the customer's max daily spend is outreach + sourcing.`
    );
  }
  return fixed(value);
}

/**
 * The SET expression for `sourcing_ceiling_cents` on an UPDATE that writes a new
 * `daily_budget_cents` without stating the split: keep the share. Column
 * references in a SET read the OLD row, so this is old sourcing x new / old.
 * Rounded to the cent and capped at the new total (the CHECK constraint).
 */
export function scaledSourcingCeilingSql(newDailyBudgetCents: string): SQL {
  const next = new Decimal(newDailyBudgetCents).toFixed(SCALE);
  return sql`CASE
    WHEN "sourcing_ceiling_cents" IS NULL OR "daily_budget_cents" = 0 THEN NULL
    ELSE LEAST(round("sourcing_ceiling_cents" * ${next}::numeric / "daily_budget_cents", 2), ${next}::numeric)
  END`;
}

/** Today's committed spend of one campaign, split in its two parts. */
export interface CampaignSpendToday {
  /** The UTC day measured, YYYY-MM-DD. */
  date: string;
  /** The campaign ids measured (a campaign FAMILY: every stored row of one campaign). */
  campaignIds: string[];
  spentCents: string;
  sourcingSpentCents: string;
  outreachSpentCents: string;
}

const SOURCING_RUN_PAGE = 500;
const MAX_SOURCING_RUN_PAGES = 200;
export const MAX_CAMPAIGN_IDS = 500;

function runsConfig() {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be configured");
  }
  return { url, apiKey };
}

/** Parse a comma-separated campaign id list. Returns null on a malformed one. */
export function parseCampaignIds(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > MAX_CAMPAIGN_IDS) return null;
  return ids;
}

async function readJson<T>(path: string, orgId: string, params: URLSearchParams): Promise<T> {
  const { url, apiKey } = runsConfig();
  const res = await fetchWithRetry(`${url}${path}?${params}`, {
    headers: { "x-api-key": apiKey, "x-org-id": orgId },
  });
  if (!res.ok) {
    throw new Error(`runs-service ${path} failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/** NET committed spend of the subtree rooted at every run of one sourcing task. */
async function sourcingSubtreeSpend(
  orgId: string,
  campaignIds: string[],
  since: Date,
  root: { serviceName: string; taskName: string }
): Promise<Decimal> {
  const byId = new Map<string, string>();
  for (let page = 0; ; page += 1) {
    if (page >= MAX_SOURCING_RUN_PAGES) {
      throw new Error(
        `runs-service ${root.serviceName}:${root.taskName} walk exceeded ${MAX_SOURCING_RUN_PAGES} pages for campaigns ${campaignIds.join(",")}`
      );
    }
    const params = new URLSearchParams({
      campaignIds: campaignIds.join(","),
      serviceName: root.serviceName,
      taskName: root.taskName,
      startedAfter: since.toISOString(),
      include: "subtreeCost",
      limit: String(SOURCING_RUN_PAGE),
      offset: String(page * SOURCING_RUN_PAGE),
    });
    const data = await readJson<{ runs?: Array<{ id: string; netTotalCostInUsdCents?: string }> }>(
      "/v1/runs",
      orgId,
      params
    );
    if (!Array.isArray(data.runs)) throw new Error("runs-service /v1/runs returned no runs array");
    for (const run of data.runs) {
      if (run.netTotalCostInUsdCents == null) {
        throw new Error(`runs-service /v1/runs?include=subtreeCost stated no net subtree cost for run ${run.id}`);
      }
      // A run inserted mid-walk shifts pages down: a repeat, deduped by id.
      byId.set(run.id, run.netTotalCostInUsdCents);
    }
    if (data.runs.length < SOURCING_RUN_PAGE) break;
  }
  let total = new Decimal(0);
  for (const cents of byId.values()) total = total.plus(cents);
  return total;
}

/**
 * Today's (UTC) committed NET spend of a campaign family, total and sourcing;
 * outreach is the rest. One aggregation for the total + one paged walk per
 * sourcing root.
 */
export async function fetchCampaignSpendToday(
  orgId: string,
  campaignIds: string[],
  now: Date = new Date()
): Promise<CampaignSpendToday> {
  const since = currentUtcDay(now);
  const totals = await readJson<{ groups?: Array<{ netTotalCostInUsdCents?: string; totalCostInUsdCents: string }> }>(
    "/v1/stats/costs",
    orgId,
    new URLSearchParams({
      campaignIds: campaignIds.join(","),
      startedAfter: since.toISOString(),
      groupBy: "campaignId",
    })
  );
  if (!Array.isArray(totals.groups)) throw new Error("runs-service /v1/stats/costs returned no groups array");
  let spent = new Decimal(0);
  for (const g of totals.groups) {
    if (g.netTotalCostInUsdCents == null) {
      throw new Error("runs-service /v1/stats/costs stated no netTotalCostInUsdCents");
    }
    spent = spent.plus(g.netTotalCostInUsdCents);
  }
  let sourcing = new Decimal(0);
  for (const root of SOURCING_ROOT_TASKS) {
    sourcing = sourcing.plus(await sourcingSubtreeSpend(orgId, campaignIds, since, root));
  }
  // A subtree descendant started just before midnight under a root started after
  // it is the only way sourcing can read above the total; outreach never goes negative.
  const outreach = Decimal.max(spent.minus(sourcing), 0);
  return {
    date: formatUtcDay(since),
    campaignIds,
    spentCents: fixed(spent),
    sourcingSpentCents: fixed(sourcing),
    outreachSpentCents: fixed(outreach),
  };
}
