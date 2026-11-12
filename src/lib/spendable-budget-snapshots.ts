/**
 * campaign-service's spendable-budget answer, served from the last read and
 * refreshed behind it (migration 0098, MON-PAGE-SPEED-1111).
 *
 * `GET /v1/accounts/runway` sits on every dashboard page (the sidebar balance
 * card). Its cost was this one sibling read: campaign-service took 0.24-1.2 s for
 * one brand serially and 2 s under load (prod 2026-11-12), every time. The runway
 * now serves the stored answer at once and asks campaign-service again behind the
 * read (single-flight per brand, at most once per REFRESH_AFTER_MS), so the answer
 * a read serves is the one the previous read fetched.
 *
 * Billing's OWN budget writes are never served stale: each stored answer carries a
 * fingerprint of billing's budget rows for that brand (daily budget, sales budget,
 * funnel caps, every column) taken when it was fetched, recomputed on every read.
 * Any write to those rows (set, clear, refusal, transfer) changes it, and an
 * answer whose fingerprint no longer matches is never served: the read waits for
 * campaign-service, exactly as before. Same for a brand never read.
 *
 * A cache of campaign-service's answer, never a source of truth: every successful
 * read overwrites the row; a failed read (null) is never stored. Only the runway
 * reads through here; the payment outlook and every money gate stay live.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaignSpendableSnapshots } from "../db/schema.js";
import { fetchSpendableBudget, type SpendableBudget } from "./campaign-service-client.js";

/** A stored answer younger than this is served without asking campaign-service again. */
export const REFRESH_AFTER_MS = 30_000;

/** Reader shape `resolveBudgets` takes (same as `fetchSpendableBudget`). */
export type SpendableBudgetReader = (orgId: string, brandId: string) => Promise<SpendableBudget | null>;

const inFlight = new Map<string, Promise<SpendableBudget | null>>();

/**
 * Billing's budget rows per brand of this org, hashed. Every column of every row
 * is in the hash (`t::text`), so no write to them can leave it unchanged. One query
 * per runway read, local, a handful of rows.
 */
export async function billingBudgetFingerprints(orgId: string): Promise<Map<string, string>> {
  const rows = (await db.execute(sql`
    SELECT brand_id::text AS brand_id, md5(string_agg(src || ':' || r, '|' ORDER BY src, r)) AS fp
      FROM (
        SELECT brand_id, 'd' AS src, t::text AS r FROM brand_daily_budgets t WHERE org_id = ${orgId}
        UNION ALL
        SELECT brand_id, 's', t::text FROM brand_sales_budgets t WHERE org_id = ${orgId}
        UNION ALL
        SELECT brand_id, 'c', t::text FROM sales_funnel_caps t WHERE org_id = ${orgId}
      ) x
     GROUP BY brand_id
  `)) as unknown as { brand_id: string; fp: string }[];
  return new Map(rows.map((r) => [r.brand_id, r.fp]));
}

/** Ask campaign-service, store a usable answer. Single-flight per (org, brand, fingerprint). */
function refresh(orgId: string, brandId: string, fingerprint: string): Promise<SpendableBudget | null> {
  const key = `${orgId}:${brandId}:${fingerprint}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = (async () => {
    const answer = await fetchSpendableBudget(orgId, brandId);
    // null = campaign-service could not answer (fetchSpendableBudget logged why).
    // Never stored: the caller sees the null, a stored answer is never replaced by it.
    if (answer === null) return null;
    const at = new Date();
    await db
      .insert(campaignSpendableSnapshots)
      .values({ orgId, brandId, body: answer, billingFingerprint: fingerprint, fetchedAt: at })
      .onConflictDoUpdate({
        target: [campaignSpendableSnapshots.orgId, campaignSpendableSnapshots.brandId],
        set: { body: answer, billingFingerprint: fingerprint, fetchedAt: at },
      });
    return answer;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/**
 * A reader for one org's runway: the stored answer when billing's budget rows are
 * unchanged since it was fetched (refreshed behind the read once it is older than
 * REFRESH_AFTER_MS), else campaign-service live.
 */
export function snapshotSpendableBudgetReader(now: () => number = Date.now): SpendableBudgetReader {
  const fingerprintsByOrg = new Map<string, Promise<Map<string, string>>>();
  return async (orgId, brandId) => {
    let fps = fingerprintsByOrg.get(orgId);
    if (!fps) {
      fps = billingBudgetFingerprints(orgId);
      fingerprintsByOrg.set(orgId, fps);
    }
    const fingerprint = (await fps).get(brandId) ?? "";
    const [stored] = await db
      .select()
      .from(campaignSpendableSnapshots)
      .where(and(eq(campaignSpendableSnapshots.orgId, orgId), eq(campaignSpendableSnapshots.brandId, brandId)))
      .limit(1);
    if (!stored || stored.billingFingerprint !== fingerprint) {
      return refresh(orgId, brandId, fingerprint);
    }
    if (now() - stored.fetchedAt.getTime() >= REFRESH_AFTER_MS) {
      refresh(orgId, brandId, fingerprint).catch((err) => {
        console.error(
          `[billing-service] spendable-budget refresh behind the runway failed for brand=${brandId} org=${orgId}:`,
          err
        );
      });
    }
    return stored.body as SpendableBudget;
  };
}
