/**
 * Giving an existing ceiling the funnel LEG of the campaign it already paces.
 *
 * WHY THIS EXISTS. Migration 0039 made the ceiling's stored grain (brand,
 * funnel, channel, offer, LEG) — the same grain a campaign is keyed on — and
 * shipped with `leg_key` NULL on every live row, because nothing here can
 * DERIVE a leg: a funnel has several legs and a leg belongs to several funnels.
 * That left the money saying "no leg" while every campaign states one, so
 * campaign-service could not find the campaign a ceiling already paces and
 * provisioned a second one beside it. Five brands ran two identical live
 * campaigns for about an hour on 2026-09-06 and were charged twice.
 *
 * WHAT MAKES IT SAFE TO WRITE. The leg is not derived, guessed or defaulted —
 * it is READ from the campaign that ALREADY stands behind that exact ceiling,
 * so the two sides match by construction rather than by a rule that could
 * drift. campaign-service performed the attribution (its
 * `GET /brands/:brandId/spendable-budget` names, per stored ceiling, the
 * campaign standing behind it) and this repo does not re-derive that join — the
 * same reason `campaign-service-client.ts` gives for reading it in the first
 * place. A second copy of the matching here would disagree with the first one
 * within a release, and disagreement is the bug.
 *
 * WHAT IT IS NOT. Not a budget change. `daily_budget_cents` is never in the SET
 * clause, and `updated_at` is left exactly as it is — the ceiling names the
 * campaign it was always paying for, and no org's charge moves by a cent.
 *
 * WHAT IT REFUSES, always by leaving the row EXACTLY as it is: a ceiling that
 * already carries a leg, a ceiling no campaign stands behind, a campaign that
 * states no leg, and a grain that is not one of this table's rows. No guess, no
 * default, no partial write.
 *
 * Fail-loud on vocabulary drift: campaign-service answers the CANONICAL funnel
 * spellings (`sales_meetings_from_conversation`) while this table stores the
 * pre-retirement ones (`reply_meeting`), so both are resolved through the ONE
 * resolver the write routes use (`toStoredFunnelKey`). A spelling neither side
 * can name THROWS rather than being skipped — a silent skip reads exactly like
 * "no campaign stands behind this ceiling", which is a legitimate outcome.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { brandFunnelDailyBudgets } from "../db/schema.js";
import {
  ACCEPTED_FUNNEL_KEYS,
  toStoredFunnelKey,
  type BrandFunnelKey,
} from "./brand-funnel-budgets.js";
import type { SpendableBudget } from "./campaign-service-client.js";

/** A funnel spelling neither side can name. Aborts the sweep. */
export class UnknownCampaignFunnelError extends Error {
  constructor(funnelKey: string, brandId: string) {
    super(
      `brand ${brandId} carries a ceiling on sales funnel "${funnelKey}", which billing cannot name. ` +
        `Known: ${ACCEPTED_FUNNEL_KEYS.join(", ")}.`
    );
    this.name = "UnknownCampaignFunnelError";
  }
}

/** The one ceiling to give a leg, and the leg its own campaign states. */
export interface CeilingLegTarget {
  funnelKey: BrandFunnelKey;
  featureSlug: string;
  offerId: string | null;
  /** features-service's canonical leg id, carried OPAQUE. */
  legKey: string;
  /** The campaign the leg was read from — for the report, never for a decision. */
  campaignId: string;
  campaignStatus: string | null;
}

export type LegAttributionDecision =
  | { attribute: true; label: string; target: CeilingLegTarget }
  | { attribute: false; label: string; reason: string };

function labelOf(row: {
  funnelKey: string | null;
  featureSlug: string | null;
  offerId: string | null;
}): string {
  return `${row.funnelKey ?? "-"}/${row.featureSlug ?? "-"}/${row.offerId ?? "-"}`;
}

/**
 * One decision per stored ceiling campaign-service echoed back.
 *
 * Pure: it reads the producer's answer and nothing else. Every "no" leaves the
 * ceiling exactly as it is.
 */
export function decideLegAttributions(
  spendable: SpendableBudget
): LegAttributionDecision[] {
  const campaignsById = new Map(
    spendable.campaigns.map((campaign) => [campaign.campaignId, campaign])
  );

  return spendable.rows.map((row): LegAttributionDecision => {
    const label = labelOf(row);

    if (row.legKey !== null && row.legKey !== undefined) {
      return { attribute: false, label, reason: "already carries a leg" };
    }
    if (!row.funnelKey || !row.featureSlug) {
      return {
        attribute: false,
        label,
        reason:
          "not a (funnel, channel) ceiling — this table holds no such grain",
      };
    }

    const funnelKey = toStoredFunnelKey(row.funnelKey);
    if (!funnelKey) {
      throw new UnknownCampaignFunnelError(row.funnelKey, spendable.brandId);
    }

    if (!row.campaignId) {
      return {
        attribute: false,
        label,
        reason: "no campaign stands behind this ceiling — left alone",
      };
    }

    const campaign = campaignsById.get(row.campaignId);
    if (!campaign) {
      return {
        attribute: false,
        label,
        reason: `campaign ${row.campaignId} is absent from the same response — left alone`,
      };
    }
    if (!campaign.legKey) {
      return {
        attribute: false,
        label,
        reason: `campaign ${row.campaignId} states no leg — left alone`,
      };
    }

    return {
      attribute: true,
      label,
      target: {
        funnelKey,
        featureSlug: row.featureSlug,
        offerId: row.offerId ?? null,
        legKey: campaign.legKey,
        campaignId: campaign.campaignId,
        campaignStatus: row.campaignStatus ?? campaign.status ?? null,
      },
    };
  });
}

export type LegAttributionOutcome =
  | {
      applied: true;
      /** Equal by construction — the amount is never in the SET clause. */
      dailyBudgetCentsBefore: string;
      dailyBudgetCentsAfter: string;
      legKey: string;
    }
  | { applied: false; reason: string };

/**
 * Write ONE leg onto ONE leg-less ceiling, atomically.
 *
 * Reverse of one row — the backfill's whole effect is this column, and every
 * ceiling it touched is named in the report:
 *   UPDATE brand_funnel_daily_budgets SET leg_key = NULL
 *    WHERE org_id = $1 AND brand_id = $2 AND funnel_key = $3
 *      AND feature_slug = $4 AND offer_id IS NOT DISTINCT FROM $5
 *      AND leg_key = $6;
 *
 * Re-runnable: the target row is selected `leg_key IS NULL`, so a second run
 * finds nothing to do and writes nothing. Concurrency-safe: the row is locked
 * for the duration, and a customer who states the leg themselves in between
 * simply wins (this then reports "no leg-less ceiling at that grain").
 *
 * Fail-loud: any DB error propagates.
 */
export async function attributeCeilingLeg(
  orgId: string,
  brandId: string,
  target: CeilingLegTarget
): Promise<LegAttributionOutcome> {
  const grain = and(
    eq(brandFunnelDailyBudgets.orgId, orgId),
    eq(brandFunnelDailyBudgets.brandId, brandId),
    eq(brandFunnelDailyBudgets.funnelKey, target.funnelKey),
    eq(brandFunnelDailyBudgets.featureSlug, target.featureSlug),
    target.offerId === null
      ? isNull(brandFunnelDailyBudgets.offerId)
      : eq(brandFunnelDailyBudgets.offerId, target.offerId)
  );

  return db.transaction(async (tx) => {
    const [legless] = await tx
      .select()
      .from(brandFunnelDailyBudgets)
      .where(and(grain, isNull(brandFunnelDailyBudgets.legKey)))
      .limit(1)
      .for("update");
    if (!legless) {
      return {
        applied: false,
        reason:
          "no leg-less ceiling at that grain — already attributed, or removed since the read",
      };
    }

    // The key is UNIQUE ... NULLS NOT DISTINCT over the six columns, so writing
    // this leg onto this grain would collide with a ceiling that already holds
    // it. Two ceilings for one campaign is the incoherence this repairs, not one
    // it may create — so refuse and leave both exactly as they are.
    const [collision] = await tx
      .select({ legKey: brandFunnelDailyBudgets.legKey })
      .from(brandFunnelDailyBudgets)
      .where(and(grain, eq(brandFunnelDailyBudgets.legKey, target.legKey)))
      .limit(1);
    if (collision) {
      return {
        applied: false,
        reason: `a ceiling at that grain already carries leg "${target.legKey}" — left alone`,
      };
    }

    // ONLY `leg_key` is set. `daily_budget_cents` is never touched, and
    // `updated_at` is deliberately left as it stands: this records the campaign
    // the ceiling was always paying for, so it is an attribution rather than a
    // customer change, and the untouched timestamp keeps the brand-level read
    // byte-identical.
    const [updated] = await tx
      .update(brandFunnelDailyBudgets)
      .set({ legKey: target.legKey })
      .where(and(grain, isNull(brandFunnelDailyBudgets.legKey)))
      .returning({
        dailyBudgetCents: brandFunnelDailyBudgets.dailyBudgetCents,
        legKey: brandFunnelDailyBudgets.legKey,
      });

    if (!updated) {
      return {
        applied: false,
        reason: "the leg-less ceiling disappeared mid-transaction — left alone",
      };
    }

    return {
      applied: true,
      dailyBudgetCentsBefore: legless.dailyBudgetCents,
      dailyBudgetCentsAfter: updated.dailyBudgetCents,
      legKey: target.legKey,
    };
  });
}
