/**
 * The last features-service catalogue answer billing read, per key (migration
 * 0091, CAPS-READ-FEATURES-DOWN-1024).
 *
 * The caps read and authorize need a funnel's pipes and the sourcing origins,
 * both features-service's. Read live, a slow or redeploying features-service held
 * every funded client's day (prod 2026-10-24: AscendQE + CeXO AI, 35 caps reads
 * "aborted due to timeout -- held (fail-closed)" on campaign-service). A funnel id
 * spells its own structure, so its definition does not move under a given id: the
 * last answer read is served while features-service cannot answer, and refreshed
 * in the background when it can.
 *
 * A cache of features-service's answer, never a source of truth: every successful
 * read overwrites the row. Never written by hand.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { featuresCatalogueSnapshots } from "../db/schema.js";

export interface StoredSnapshot {
  body: unknown;
  fetchedAt: Date;
}

export async function readCatalogueSnapshot(key: string): Promise<StoredSnapshot | null> {
  const [row] = await db
    .select()
    .from(featuresCatalogueSnapshots)
    .where(eq(featuresCatalogueSnapshots.key, key))
    .limit(1);
  return row ? { body: row.body, fetchedAt: row.fetchedAt } : null;
}

export async function writeCatalogueSnapshot(key: string, body: unknown): Promise<void> {
  await db
    .insert(featuresCatalogueSnapshots)
    .values({ key, body, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: featuresCatalogueSnapshots.key,
      set: { body, fetchedAt: new Date() },
    });
}
