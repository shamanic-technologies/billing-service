/**
 * Per-campaign authorize-cost tracking — feeds the read-only affordability gate.
 *
 * The required_cents resolved by the most recent authorize attempt for a
 * campaign is the best up-front estimate of its next run's cost (a campaign
 * re-runs the same workflow → ~constant cost). We upsert it on EVERY authorize
 * that carries an x-campaign-id, on both sufficient and insufficient outcomes.
 *
 * Fail-loud: any DB error propagates (no swallow).
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  campaignAuthorizeCosts,
  type CampaignAuthorizeCost,
} from "../db/schema.js";

/**
 * Record the resolved required_cents of the latest authorize attempt for a
 * campaign. One row per campaign (PK), upserted in place.
 */
export async function upsertCampaignAuthorizeCost(
  campaignId: string,
  orgId: string,
  requiredCents: string
): Promise<void> {
  await db
    .insert(campaignAuthorizeCosts)
    .values({
      campaignId,
      orgId,
      lastAuthorizeRequiredCents: requiredCents,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: campaignAuthorizeCosts.campaignId,
      set: {
        orgId,
        lastAuthorizeRequiredCents: requiredCents,
        updatedAt: new Date(),
      },
    });
}

/** Read the stored authorize cost for a campaign, or null if none recorded. */
export async function getCampaignAuthorizeCost(
  campaignId: string
): Promise<CampaignAuthorizeCost | null> {
  const [row] = await db
    .select()
    .from(campaignAuthorizeCosts)
    .where(eq(campaignAuthorizeCosts.campaignId, campaignId))
    .limit(1);
  return row ?? null;
}
