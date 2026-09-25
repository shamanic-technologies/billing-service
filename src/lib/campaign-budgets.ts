/**
 * A daily ceiling per CAMPAIGN, with no sales funnel.
 *
 * The fleet is retiring the sales funnel. A campaign is (offer x leg x
 * acquisition channel): the offer is what the brand sells, the LEG is the move a
 * lead makes from one step to the next, and the channel (a features-service
 * feature slug) is what performs that leg. One leg belongs to several funnels, so
 * while ceilings were keyed on the funnel the same campaign could hold several
 * ceilings under different funnels and every total would count its money more
 * than once. This module addresses a ceiling by the campaign alone.
 *
 * STORAGE IS THE SAME TABLE. `brand_funnel_daily_budgets.funnel_key` is nullable
 * since migration 0047; a NULL is a ceiling stated here. Such a row counts in
 * every TOTAL (the brand-level read, the funnel-budgets read's total, the
 * per-offer and per-leg reads) and is never rendered in a funnel-grain array,
 * because every consumer of those arrays parses a funnel key. A later wave drops
 * the funnel once no consumer reads it.
 *
 * ONE CAMPAIGN, ONE ROW — THE RESOLUTION (`campaignCeilingRows`). The read and
 * the write share one rule for which stored ceilings ARE this campaign's money:
 *
 *   - a ceiling on this channel naming this offer and this leg, under ANY funnel
 *     or none, is this campaign's;
 *   - a ceiling on this channel with NO offer (written before offers existed)
 *     is this campaign's only while the brand names no OTHER offer — the rule
 *     `offerBudgetRows` already applies, so the brand's money has one owner;
 *   - a ceiling with NO leg (written before legs existed) is this campaign's
 *     only while that channel names no OTHER leg, for the same reason one grain
 *     down.
 *
 * The read answers the SUM of those rows, so it never disagrees with the brand
 * total that already counts them. The write CONSOLIDATES them: it keeps one row
 * (a funnel-keyed one when there is one, so every funnel-grain read keeps
 * showing the money), stamps it with this campaign's offer and leg, sets the new
 * amount, and deletes the rest. When nothing matches it opens a funnel-less row.
 *
 * Measured in production at ship time: 28 ceilings, ZERO sharing
 * (org, brand, offer, leg, channel) — so no existing row is consolidated by
 * shipping this; consolidation only happens when a customer re-states a campaign.
 *
 * Fail-loud: any DB error propagates.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  brandDailyBudgets,
  brandDailyBudgetChanges,
  brandFunnelDailyBudgets,
  type CeilingRow,
} from "../db/schema.js";
import { addCents, parseNonNegativeCents } from "./cents.js";
import { getChannelMinimums } from "./channel-terms.js";
import {
  InvalidFunnelSetError,
  assertChannelGroupMeetsMinimum,
  funnelMatches,
  legMatches,
  namedLegsOf,
  namedOffersOf,
  offerMatches,
  sortByFunnelOrder,
  sumFunnelBudgets,
} from "./brand-funnel-budgets.js";

/** One campaign: what is sold, the leg it moves a lead along, the channel doing it. */
export interface CampaignKey {
  /** brand-service offer UUID, lower-cased. */
  offerId: string;
  /** features-service's canonical leg id, carried OPAQUE and never parsed. */
  legKey: string;
  /** features-service feature slug of the acquisition channel. */
  featureSlug: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a campaign address. All three are REQUIRED: a campaign is exactly
 * (offer x leg x channel), so an address missing one names no campaign. Shape
 * only — billing validates none of them against their owners.
 */
export function parseCampaignKey(input: {
  offerId?: unknown;
  legKey?: unknown;
  featureSlug?: unknown;
}): CampaignKey {
  const { offerId, legKey, featureSlug } = input;
  if (typeof offerId !== "string" || !UUID_RE.test(offerId.trim())) {
    throw new InvalidFunnelSetError("offerId must be a valid offer UUID.");
  }
  if (typeof legKey !== "string" || !legKey.trim()) {
    throw new InvalidFunnelSetError("legKey must be a non-empty funnel leg id.");
  }
  if (typeof featureSlug !== "string" || !featureSlug.trim()) {
    throw new InvalidFunnelSetError(
      "featureSlug must be a non-empty acquisition-channel feature slug."
    );
  }
  return {
    offerId: offerId.trim().toLowerCase(),
    legKey: legKey.trim(),
    featureSlug: featureSlug.trim(),
  };
}

/**
 * The stored ceilings that ARE this campaign's money — see the module header.
 * Shared by the read and the write, so the two can never disagree about it.
 */
export function campaignCeilingRows<R extends CeilingRow>(
  rows: R[],
  key: CampaignKey
): R[] {
  const onChannel = rows.filter((row) => row.featureSlug === key.featureSlug);
  const otherOfferNamed = namedOffersOf(rows).some((o) => o !== key.offerId);
  const otherLegNamed = namedLegsOf(onChannel).some((l) => l !== key.legKey);
  return onChannel.filter(
    (row) =>
      (row.offerId === key.offerId ||
        (row.offerId === null && !otherOfferNamed)) &&
      (row.legKey === key.legKey || (row.legKey === null && !otherLegNamed))
  );
}

/** One campaign's ceiling as stored: the SUM of its rows across every funnel. */
export interface CampaignBudgetTotal {
  offerId: string | null;
  legKey: string | null;
  featureSlug: string;
  dailyBudgetCents: string;
  updatedAt: Date;
}

/**
 * Every stored ceiling of a brand, one entry per (offer, leg, channel) with the
 * funnel dropped — rows the funnel used to split are summed here, and this is
 * the ONLY place that sum is composed. The entries add up to the brand total by
 * construction. A NULL offer or leg is shown as stored (a ceiling written before
 * that dimension existed); the per-campaign read resolves it.
 */
export function aggregateCampaignTotals(
  rows: CeilingRow[]
): CampaignBudgetTotal[] {
  const byCampaign = new Map<string, CampaignBudgetTotal>();
  for (const row of rows) {
    const k = `${row.featureSlug}\u0000${row.offerId ?? ""}\u0000${row.legKey ?? ""}`;
    const current = byCampaign.get(k);
    if (!current) {
      byCampaign.set(k, {
        offerId: row.offerId,
        legKey: row.legKey,
        featureSlug: row.featureSlug,
        dailyBudgetCents: row.dailyBudgetCents,
        updatedAt: row.updatedAt,
      });
      continue;
    }
    current.dailyBudgetCents = addCents(
      current.dailyBudgetCents,
      row.dailyBudgetCents
    );
    if (row.updatedAt > current.updatedAt) current.updatedAt = row.updatedAt;
  }
  return [...byCampaign.values()].sort(
    (a, b) =>
      a.featureSlug.localeCompare(b.featureSlug) ||
      (a.offerId ?? "").localeCompare(b.offerId ?? "") ||
      (a.legKey ?? "").localeCompare(b.legKey ?? "")
  );
}

/** One campaign's ceiling, or null when nothing funds it (never read as 0). */
export function campaignBudgetOf(
  rows: CeilingRow[],
  key: CampaignKey
): { dailyBudgetCents: string; updatedAt: Date } | null {
  const owned = campaignCeilingRows(rows, key);
  if (owned.length === 0) return null;
  let updatedAt = owned[0].updatedAt;
  for (const row of owned) {
    if (row.updatedAt > updatedAt) updatedAt = row.updatedAt;
  }
  return { dailyBudgetCents: sumFunnelBudgets(owned), updatedAt };
}

export interface SetCampaignBudgetResult {
  /** Every stored ceiling BEFORE the write, read under the lock. */
  previousCeilings: CeilingRow[];
  /** Every stored ceiling AFTER the write. */
  ceilings: CeilingRow[];
  /** The brand-level daily budget before the write (null = never configured). */
  previousBrandDailyBudgetCents: string | null;
  /** The brand-level daily budget after = the sum of every ceiling. */
  brandDailyBudgetCents: string;
  /** This campaign's ceiling after the write. */
  campaign: { dailyBudgetCents: string; updatedAt: Date };
}

/**
 * State one campaign's daily ceiling, atomically. Other campaigns are untouched.
 *
 * The acquisition channel's published floor applies, judged on the channel's
 * TOTAL across the brand (the funnel-less analogue of the (funnel, channel)
 * group the funnel-keyed write judges), with the same grandfather: a channel
 * already funded below its floor may be kept or raised, 0 is always accepted.
 *
 * Like the funnel-keyed write, it drops a superseded brand-level scalar (the
 * brand is ceiling-funded from now on) and appends one history row carrying the
 * new brand TOTAL.
 */
export async function setCampaignDailyBudget(
  orgId: string,
  brandId: string,
  key: CampaignKey,
  dailyBudgetCentsInput: unknown
): Promise<SetCampaignBudgetResult> {
  let dailyBudgetCents: string;
  try {
    dailyBudgetCents = parseNonNegativeCents(dailyBudgetCentsInput);
  } catch (err) {
    throw new InvalidFunnelSetError(
      err instanceof Error ? err.message : "invalid dailyBudgetCents"
    );
  }

  // Read before the lock — a network read has no business inside one.
  const minimums = await getChannelMinimums();

  return db.transaction(async (tx) => {
    const changedAt = new Date();
    const whereBrand = and(
      eq(brandFunnelDailyBudgets.orgId, orgId),
      eq(brandFunnelDailyBudgets.brandId, brandId)
    );

    const existing = sortByFunnelOrder(
      await tx
        .select()
        .from(brandFunnelDailyBudgets)
        .where(whereBrand)
        .for("update")
    );
    const [brandRow] = await tx
      .select()
      .from(brandDailyBudgets)
      .where(
        and(
          eq(brandDailyBudgets.orgId, orgId),
          eq(brandDailyBudgets.brandId, brandId)
        )
      )
      .limit(1)
      .for("update");

    const owned = campaignCeilingRows(existing, key);
    const ownedSet = new Set(owned);

    const channelRows = existing.filter(
      (row) => row.featureSlug === key.featureSlug
    );
    assertChannelGroupMeetsMinimum(
      key.featureSlug,
      key.featureSlug,
      addCents(
        sumFunnelBudgets(channelRows.filter((row) => !ownedSet.has(row))),
        dailyBudgetCents
      ),
      channelRows.length > 0 ? sumFunnelBudgets(channelRows) : null,
      minimums
    );

    const previousBrandDailyBudgetCents =
      existing.length > 0
        ? sumFunnelBudgets(existing)
        : brandRow
          ? brandRow.dailyBudgetCents
          : null;

    // `existing` is funnel-ordered with funnel-less rows last, so the keeper is
    // a funnel-keyed row whenever there is one: funnel-grain reads keep showing
    // this money until their consumers move.
    const [keeper, ...rest] = owned;
    for (const row of rest) {
      await tx.delete(brandFunnelDailyBudgets).where(identityOf(orgId, brandId, row));
    }
    if (keeper) {
      await tx
        .update(brandFunnelDailyBudgets)
        .set({
          offerId: key.offerId,
          legKey: key.legKey,
          dailyBudgetCents,
          updatedAt: changedAt,
        })
        .where(identityOf(orgId, brandId, keeper));
    } else {
      await tx.insert(brandFunnelDailyBudgets).values({
        orgId,
        brandId,
        funnelKey: null,
        featureSlug: key.featureSlug,
        offerId: key.offerId,
        legKey: key.legKey,
        dailyBudgetCents,
        updatedAt: changedAt,
      });
    }

    const ceilings = sortByFunnelOrder(
      await tx.select().from(brandFunnelDailyBudgets).where(whereBrand)
    );
    const brandDailyBudgetCents = sumFunnelBudgets(ceilings);

    if (brandRow) {
      await tx
        .delete(brandDailyBudgets)
        .where(
          and(
            eq(brandDailyBudgets.orgId, orgId),
            eq(brandDailyBudgets.brandId, brandId)
          )
        );
    }

    await tx.insert(brandDailyBudgetChanges).values({
      orgId,
      brandId,
      dailyBudgetCents: brandDailyBudgetCents,
      changedAt,
    });

    const campaign = campaignBudgetOf(ceilings, key);
    if (!campaign) {
      // Unreachable by construction: the row just written names this exact
      // campaign. Fail loud rather than answer a campaign with no ceiling.
      throw new Error(
        `campaign ceiling for ${key.offerId}/${key.legKey}/${key.featureSlug} missing after write`
      );
    }

    return {
      previousCeilings: existing,
      ceilings,
      previousBrandDailyBudgetCents,
      brandDailyBudgetCents,
      campaign,
    };
  });
}

/** Match exactly one stored ceiling (all six key columns, nulls as values). */
function identityOf(orgId: string, brandId: string, row: CeilingRow) {
  return and(
    eq(brandFunnelDailyBudgets.orgId, orgId),
    eq(brandFunnelDailyBudgets.brandId, brandId),
    funnelMatches(row.funnelKey),
    eq(brandFunnelDailyBudgets.featureSlug, row.featureSlug),
    offerMatches(row.offerId),
    legMatches(row.legKey)
  );
}
