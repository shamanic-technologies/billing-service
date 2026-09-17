/**
 * "This org cannot spend" — the ONE predicate, shared by everything that
 * decides an org is out of credit.
 *
 * THE TRAP THIS EXISTS TO CLOSE. Two rules decided the same thing and did not
 * agree, and the gap between them was a state an org could not climb out of:
 *
 *   - `GET /internal/campaigns/:id/affordability` refuses the next run when
 *     `balance − lastRequired < floor`.
 *   - the depletion episode opened when `balance <= floor`.
 *
 * The gap is exactly `lastRequired` wide. Inside it every run is refused, so the
 * balance never moves, so it can never cross the floor, so no episode ever
 * opened and the dunning engine never owned the org. Permanent, not slow.
 * Measured in prod 2026-09-17, org 81b34252-…: balance −4994.13 against a −5000
 * floor with an 11.80-cent estimate — 5.87 cents of headroom for a run needing
 * 11.80, 83 consecutive refusals over 41 hours, and ZERO depletion episodes
 * ever recorded for that org.
 *
 * So the refusal IS the depletion: an org whose next run cannot be authorized
 * is out of credit, whatever side of its credit line the balance sits on.
 *
 * Note what this does NOT do. It is strictly about whether the NEXT RUN can be
 * authorized, so a postpaid org running normally negative WITHIN its credit line
 * is not blocked and never enters dunning — which is a NARROWING of the dunning
 * tick's previous gate, not a widening (that gate compared the balance against a
 * hardcoded "0" and therefore called every postpaid org depleted).
 */

import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { isDepleted, subCents, gte as gteCents } from "./cents.js";
import { resolvePostpaidTier, type TopupTier } from "./topup-tier.js";
import type { BalanceSnapshot } from "./balance.js";

/**
 * True when this org cannot pay for its next run of `requiredCents`.
 *
 * Two clauses, and both are load-bearing:
 *   - `balance − required < floor` is the affordability pre-flight's refusal,
 *     restated verbatim. This is what covers the gap band.
 *   - `balance <= floor` is the legacy depletion check, kept so a `required` of
 *     0 (an org with no stored estimate) behaves exactly as it always did —
 *     the subtraction alone would read a balance sitting EXACTLY on the floor as
 *     spendable, which it is not.
 */
export function cannotSpend(
  balanceCents: string,
  requiredCents: string,
  floorCents: string
): boolean {
  if (isDepleted(balanceCents, floorCents)) return true;
  return !gteCents(subCents(balanceCents, requiredCents), floorCents);
}

export interface OrgFloor {
  /**
   * The org's derived postpaid tier, or null when it has no credit line (no
   * auto-topup config, no chargeable card, or a blocked issuing country).
   */
  tier: TopupTier | null;
  /** The org's postpaid credit-line floor ("0" when it has no credit line). */
  floorCents: string;
}

export interface SpendBlock extends OrgFloor {
  /** The largest stored campaign estimate for this org ("0" when none). */
  requiredCents: string;
  /** Whether the next run is refused right now. */
  blocked: boolean;
}

/**
 * The org's credit-line floor, from its stored auto-topup flag (the credit line
 * exists only for an org that can actually be reloaded) and the balance
 * snapshot's card facts. The ONE place that account read + `resolvePostpaidTier`
 * are composed for a user-less path; `authorize` composes the same thing from
 * the account row it already holds.
 */
export async function resolveOrgFloor(
  orgId: string,
  snapshot: BalanceSnapshot
): Promise<OrgFloor> {
  const [account] = await db
    .select({ topupAmountCents: billingAccounts.topupAmountCents })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  const { tier, thresholdCents } = resolvePostpaidTier({
    topupEnabled: account?.topupAmountCents != null,
    hasCardPm: snapshot.hasCardPm,
    autoReloadSupported: snapshot.autoReloadSupported,
    paidTopupsCents: snapshot.paidTopupsCents,
  });
  return { tier, floorCents: thresholdCents };
}

/**
 * The largest authorize estimate stored across an org's campaigns.
 *
 * The largest is the right one for the same reason the reload sweep picks it:
 * an org that can afford its hungriest campaign can afford every other one, and
 * a smaller estimate would call a wedged org spendable.
 */
export async function maxCampaignEstimateCents(orgId: string): Promise<string> {
  const rows = await db.execute<{ max_required: string | null }>(sql`
    SELECT MAX(last_authorize_required_cents) AS max_required
    FROM campaign_authorize_costs
    WHERE org_id = ${orgId}
  `);
  const row = (rows as unknown as { max_required: string | null }[])[0];
  return row?.max_required != null ? String(row.max_required) : "0";
}

/**
 * Resolve, for one org, whether ANY of its campaigns is refused right now —
 * judged on the LARGEST stored estimate, from a balance snapshot the caller
 * already holds. Pure read.
 *
 * The sweep and the dunning tick both read through this, so the org they charge
 * for and the org they dun are decided by one function. The affordability
 * pre-flight is per CAMPAIGN and uses `resolveOrgFloor` + `cannotSpend` with that
 * campaign's own estimate instead.
 */
export async function resolveSpendBlock(
  orgId: string,
  snapshot: BalanceSnapshot
): Promise<SpendBlock> {
  const [floor, requiredCents] = await Promise.all([
    resolveOrgFloor(orgId, snapshot),
    maxCampaignEstimateCents(orgId),
  ]);
  return {
    ...floor,
    requiredCents,
    blocked: cannotSpend(snapshot.balanceCents, requiredCents, floor.floorCents),
  };
}
