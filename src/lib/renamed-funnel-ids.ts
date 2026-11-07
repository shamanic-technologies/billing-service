/**
 * A STEP RENAMED in features-service's catalogue re-keys every sales funnel id that spells
 * it (DELETE-POST-PUBLISHED-1107, owner 2026-11-07: the coarse outcome `post_published` is
 * retired; every leg spelled with it is a Threads leg, now `threads_post_published`).
 *
 * Migration 0096 stated each cap held under an old id AGAIN under its new id (same values,
 * history copied), so a funnel campaign is held to the same cap whichever id it carries
 * while campaign-service re-keys it. This module RETIRES the old-id row once no funnel
 * campaign of the org carries the old id: through the normal clear (`setSalesFunnelCaps`
 * with nothing stated), so the history gets its "cleared" row and nothing is deleted from
 * it. Kept while a campaign still carries the old id, while campaign-service is unreadable,
 * or while the new-id twin is missing or states another cap (a write after the copy: a
 * person decides, never this sweep).
 *
 * The renames are DATA (one row per retired step), the rule is the same for each: the step
 * as a TOKEN of the id (start, or after `@` / `+` / `_to_`; then the end, `@`, `+` or
 * `_to_`), never a substring of a finer key (`x_post_published` is left alone). The
 * migration's SQL spells the same rule; `renamed-funnel-ids.test.ts` pins both.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { salesFunnelCaps, type SalesFunnelCapRow } from "../db/schema.js";
import { fetchSalesFunnelCampaigns, type SalesFunnelCampaignsAnswer } from "./funnel-campaigns.js";
import { setSalesFunnelCaps } from "./sales-funnel-caps.js";
import { errorReason } from "./pg-error.js";

/** Steps retired from the catalogue, each with the step that replaces it in every funnel id. */
export const RENAMED_STEPS: ReadonlyArray<{ from: string; to: string; decided: string }> = [
  { from: "post_published", to: "threads_post_published", decided: "2026-11-07" },
];

const tokenOf = (step: string) => new RegExp(`(^|[@+]|_to_)${step}(?=$|[@+]|_to_)`, "g");

/** PURE: the id this funnel id is re-keyed to, or null when it spells no renamed step. */
export function renamedFunnelId(id: string): string | null {
  let out = id;
  for (const r of RENAMED_STEPS) out = out.replace(tokenOf(r.from), `$1${r.to}`);
  return out === id ? null : out;
}

/** PURE: do two cap rows state the same caps (amounts, periods, since)? */
export function sameCaps(a: SalesFunnelCapRow, b: SalesFunnelCapRow): boolean {
  const num = (v: string | null) => (v == null ? null : Number(v));
  const t = (d: Date | null) => (d == null ? null : d.getTime());
  return (
    num(a.maxBudgetCents) === num(b.maxBudgetCents) &&
    a.maxBudgetPeriod === b.maxBudgetPeriod &&
    t(a.maxBudgetSince) === t(b.maxBudgetSince) &&
    a.maxVolume === b.maxVolume &&
    a.maxVolumePeriod === b.maxVolumePeriod &&
    t(a.maxVolumeSince) === t(b.maxVolumeSince)
  );
}

export type RenamedCapVerdict =
  | "retired"
  | "campaign_still_on_old_id"
  | "campaign_service_unreadable"
  | "twin_missing"
  | "twin_differs";

export interface RenamedCapOutcome {
  orgId: string;
  brandId: string;
  offerId: string;
  salesFunnelId: string;
  renamedTo: string;
  salesFunnelCampaignId: string | null;
  verdict: RenamedCapVerdict;
}

/**
 * Retire every old-id cap row whose twin holds the same cap and that no funnel campaign of
 * the org still carries. Idempotent; never throws for one row (logged, kept).
 */
export async function retireRenamedFunnelCaps(
  readCampaigns: (orgId: string) => Promise<SalesFunnelCampaignsAnswer> = fetchSalesFunnelCampaigns
): Promise<RenamedCapOutcome[]> {
  const rows = (await db.select().from(salesFunnelCaps)).filter((r) => renamedFunnelId(r.salesFunnelId) !== null);
  const out: RenamedCapOutcome[] = [];
  const campaignsOf = new Map<string, SalesFunnelCampaignsAnswer>();
  for (const row of rows) {
    const renamedTo = renamedFunnelId(row.salesFunnelId)!;
    const base = {
      orgId: row.orgId,
      brandId: row.brandId,
      offerId: row.offerId,
      salesFunnelId: row.salesFunnelId,
      renamedTo,
      salesFunnelCampaignId: row.salesFunnelCampaignId ?? null,
    };
    try {
      const [twin] = await db
        .select()
        .from(salesFunnelCaps)
        .where(
          and(
            eq(salesFunnelCaps.orgId, row.orgId),
            eq(salesFunnelCaps.brandId, row.brandId),
            eq(salesFunnelCaps.offerId, row.offerId),
            eq(salesFunnelCaps.salesFunnelId, renamedTo),
            row.salesFunnelCampaignId
              ? eq(salesFunnelCaps.salesFunnelCampaignId, row.salesFunnelCampaignId)
              : isNull(salesFunnelCaps.salesFunnelCampaignId)
          )
        )
        .limit(1);
      if (!twin) {
        out.push({ ...base, verdict: "twin_missing" });
        continue;
      }
      if (!sameCaps(row, twin)) {
        out.push({ ...base, verdict: "twin_differs" });
        continue;
      }
      if (!campaignsOf.has(row.orgId)) campaignsOf.set(row.orgId, await readCampaigns(row.orgId));
      const answer = campaignsOf.get(row.orgId)!;
      if (!answer.ok) {
        out.push({ ...base, verdict: "campaign_service_unreadable" });
        continue;
      }
      if (answer.campaigns.some((c) => c.salesFunnelId === row.salesFunnelId)) {
        out.push({ ...base, verdict: "campaign_still_on_old_id" });
        continue;
      }
      await setSalesFunnelCaps(
        { orgId: row.orgId, brandId: row.brandId, offerId: row.offerId, salesFunnelId: row.salesFunnelId, salesFunnelCampaignId: base.salesFunnelCampaignId },
        { maxBudget: null, maxVolume: null },
        null
      );
      out.push({ ...base, verdict: "retired" });
    } catch (err) {
      console.error(`[billing-service] renamed funnel cap ${row.salesFunnelId} org=${row.orgId}: ${errorReason(err)}`);
      out.push({ ...base, verdict: "campaign_service_unreadable" });
    }
  }
  for (const o of out) {
    const line = `[billing-service] renamed funnel cap ${o.salesFunnelId} -> ${o.renamedTo} org=${o.orgId}: ${o.verdict}`;
    if (o.verdict === "retired" || o.verdict === "campaign_still_on_old_id") console.log(line);
    else console.error(line);
  }
  return out;
}

const FIRST_TICK_MS = 60_000;
const TICK_MS = 15 * 60_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

/** First tick a minute after boot, then every 15 min; a tick finding no old-id row reads nothing else. */
export function startRenamedFunnelCapRetirement(): void {
  const tick = async () => {
    if (!running) {
      running = true;
      try {
        await retireRenamedFunnelCaps();
      } catch (err) {
        console.error(`[billing-service] renamed funnel cap retirement failed: ${errorReason(err)}`);
      } finally {
        running = false;
      }
    }
    timer = setTimeout(tick, TICK_MS);
  };
  timer = setTimeout(tick, FIRST_TICK_MS);
}

export function stopRenamedFunnelCapRetirement(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
