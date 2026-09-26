/**
 * A daily spending ceiling per CAMPAIGN of a brand.
 *
 * A campaign is (offer x leg x acquisition channel): the offer is what the brand
 * sells, the LEG is the move a lead makes from one step to the next, and the
 * channel (a features-service feature slug) is what performs that leg. One row
 * of `campaign_daily_budgets` per campaign, so a ceiling is addressed by the
 * campaign alone.
 *
 * The sales funnel used to be part of a ceiling's identity. It was retired
 * fleet-wide (one leg belongs to several funnels, so the funnel never identified
 * what was bought and a total could count one campaign's money twice), and
 * migration 0048 dropped it from this table after snapshotting it in production.
 * Nothing here stores, serves or accepts a funnel any more.
 *
 * THE READS ARE SUMS, AND NOBODY ELSE ADDS ANYTHING UP. The brand-wide figure
 * (`getBrandDailyBudget`) is the sum of every ceiling; the per-offer and per-leg
 * figures are the sums of the ceilings funding that offer / leg. A consumer that
 * sums is a consumer that will disagree with this service one day, so every
 * figure it could want is served here.
 *
 * WHICH IDENTIFIERS EXIST IS NOT THIS SERVICE'S STATEMENT. brand-service owns
 * offers, features-service owns legs and channels; billing stores whatever the
 * customer funds and validates none of them against their owners. A leg id is
 * OPAQUE and never parsed.
 *
 * NULL OFFER / NULL LEG. A ceiling written before offers (or legs) existed names
 * none. That NULL is a permanent value, never backfilled, and it is resolved by
 * one rule shared by the read and the write:
 *
 *   - a ceiling on this channel naming this offer and this leg is this
 *     campaign's;
 *   - a ceiling with NO offer is this campaign's only while the brand names no
 *     OTHER offer — then the brand's money has one owner;
 *   - a ceiling with NO leg is this campaign's only while that channel names no
 *     OTHER leg, for the same reason one grain down.
 *
 * The brand-level scalar (`brand_daily_budgets`) and these ceilings are mutually
 * exclusive by construction: the first ceiling write DELETES the brand-level row
 * (same transaction), and PATCH /v1/brands/:brandId/daily-budget refuses (409) a
 * brand that is ceiling-funded.
 *
 * Fail-loud: any DB error propagates.
 */

import { and, eq, isNull } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import {
  brandDailyBudgets,
  brandDailyBudgetChanges,
  campaignDailyBudgets,
  type CeilingRow,
} from "../db/schema.js";
import { addCents, parseNonNegativeCents } from "./cents.js";
import { getChannelMinimums, type ChannelMinimums } from "./channel-terms.js";

export {
  UnknownAcquisitionChannelError,
  ChannelTermsUnavailableError,
} from "./channel-terms.js";

/** A funded channel below its published daily minimum. Surfaced as a 400. */
export class CeilingBelowMinimumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CeilingBelowMinimumError";
  }
}

/** A malformed campaign address or amount. Surfaced as a 400. */
export class InvalidCeilingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCeilingError";
  }
}

/**
 * A brand-level daily-budget write against a brand funded per campaign.
 * Surfaced as a 409 — the brand-level value is DERIVED there, so accepting the
 * write would leave two numbers claiming to be the same thing.
 */
export class BrandBudgetManagedByCampaignsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandBudgetManagedByCampaignsError";
  }
}

/** Render cents as a dollars-per-day figure for a human-readable message. */
function dollarsPerDay(cents: string | number): string {
  const dollars = new Decimal(cents).dividedBy(100);
  const rendered = dollars.isInteger()
    ? dollars.toFixed(0)
    : dollars.toDecimalPlaces(2).toFixed(2);
  return `$${rendered}/day`;
}

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
    throw new InvalidCeilingError("offerId must be a valid offer UUID.");
  }
  if (typeof legKey !== "string" || !legKey.trim()) {
    throw new InvalidCeilingError("legKey must be a non-empty leg id.");
  }
  if (typeof featureSlug !== "string" || !featureSlug.trim()) {
    throw new InvalidCeilingError(
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
 * A funded channel must clear its published floor, and the floor binds the
 * channel's TOTAL across the brand — never one ceiling in isolation, so
 * splitting one funded channel across two offers or two legs changes nothing
 * about whether it may run.
 *
 * Zero is exempt — a channel whose ceilings all sit at 0 is "not funding that
 * right now", an ordinary state.
 *
 * GRANDFATHERING. The minimum polices what a customer may NEWLY STATE, not what
 * one has already been running. A channel whose STORED total is above zero and
 * below its minimum may be re-stated or RAISED to any higher value, including
 * one still below the minimum; it may not be LOWERED to another funded
 * sub-minimum value. The grandfather is spent the moment the total reaches the
 * minimum. Derived from the stored ceilings and nothing else.
 *
 * `storedDailyBudgetCents` is the channel's current total (null when it funds
 * none), read under the write lock.
 */
export function assertChannelMeetsMinimum(
  featureSlug: string,
  dailyBudgetCents: string,
  storedDailyBudgetCents: string | null,
  minimums: ChannelMinimums
): void {
  // The channel is resolved BEFORE the zero shortcut: a slug whose published
  // terms state no daily operating cost is refused whatever the amount, so a
  // channel nobody prices can never be stored.
  const minimum = minimums.minimumFor(featureSlug);

  const value = new Decimal(dailyBudgetCents);
  if (value.isZero()) return;
  if (value.greaterThanOrEqualTo(minimum)) return;

  const stored =
    storedDailyBudgetCents === null ? null : new Decimal(storedDailyBudgetCents);
  const grandfathered =
    stored !== null && stored.greaterThan(0) && stored.lessThan(minimum);

  if (grandfathered) {
    if (value.greaterThanOrEqualTo(stored)) return;
    throw new CeilingBelowMinimumError(
      `${featureSlug} is funded at ${dollarsPerDay(stored.toString())}, below the ${dollarsPerDay(minimum)} this channel now needs to run. You can keep it at ${dollarsPerDay(stored.toString())}, raise it, or set it to 0 to stop funding it — you set ${dollarsPerDay(dailyBudgetCents)}.`
    );
  }

  throw new CeilingBelowMinimumError(
    `${featureSlug} needs at least ${dollarsPerDay(minimum)} to run — you set ${dollarsPerDay(dailyBudgetCents)}. Set it to 0 if you do not want to fund this channel right now.`
  );
}

/** Sum of a set of ceilings, canonical fixed-scale string. */
export function sumCeilings(rows: Array<{ dailyBudgetCents: string }>): string {
  return rows.reduce(
    (total, row) => addCents(total, row.dailyBudgetCents),
    "0.0000000000"
  );
}

/** The latest `updatedAt` of a non-empty set of rows. */
function latestUpdatedAt(rows: Array<{ updatedAt: Date }>): Date {
  let updatedAt = rows[0].updatedAt;
  for (const row of rows) {
    if (row.updatedAt > updatedAt) updatedAt = row.updatedAt;
  }
  return updatedAt;
}

/** Every offer this brand names, in stable order. Unscoped ceilings name none. */
export function namedOffersOf(rows: Array<{ offerId: string | null }>): string[] {
  return [
    ...new Set(
      rows
        .map((row) => row.offerId)
        .filter((offerId): offerId is string => offerId !== null)
    ),
  ];
}

/** Every leg these rows name, in stable order. Leg-less ceilings name none. */
export function namedLegsOf(rows: Array<{ legKey: string | null }>): string[] {
  return [
    ...new Set(
      rows
        .map((row) => row.legKey)
        .filter((legKey): legKey is string => legKey !== null)
    ),
  ];
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

/**
 * The stored ceilings that fund one OFFER. A ceiling that NAMES the offer always
 * counts; an UNSCOPED one counts only when this offer is the brand's SOLE named
 * one. An offer that names nothing here has NO ceiling — a different answer from
 * a ceiling of zero.
 */
export function offerBudgetRows<R extends CeilingRow>(
  rows: R[],
  offerId: string
): R[] {
  const owned = rows.filter((row) => row.offerId === offerId);
  if (owned.length === 0) return [];
  const named = namedOffersOf(rows);
  const soleNamedOffer = named.length === 1 && named[0] === offerId;
  if (!soleNamedOffer) return owned;
  return rows.filter((row) => row.offerId === offerId || row.offerId === null);
}

/**
 * The stored ceilings that fund one LEG — the rule `offerBudgetRows` holds, one
 * grain down. A LEG-LESS ceiling counts only when this leg is the brand's SOLE
 * named one.
 */
export function legBudgetRows<R extends CeilingRow>(
  rows: R[],
  legKey: string
): R[] {
  const owned = rows.filter((row) => row.legKey === legKey);
  if (owned.length === 0) return [];
  const named = namedLegsOf(rows);
  const soleNamedLeg = named.length === 1 && named[0] === legKey;
  if (!soleNamedLeg) return owned;
  return rows.filter((row) => row.legKey === legKey || row.legKey === null);
}

/** One campaign's ceiling as stored. */
export interface CampaignBudgetTotal {
  offerId: string | null;
  legKey: string | null;
  featureSlug: string;
  dailyBudgetCents: string;
  updatedAt: Date;
}

/** Render stored ceilings as campaign entries, in stable order. */
export function campaignTotalsOf(rows: CeilingRow[]): CampaignBudgetTotal[] {
  return sortCeilings(rows).map((row) => ({
    offerId: row.offerId,
    legKey: row.legKey,
    featureSlug: row.featureSlug,
    dailyBudgetCents: row.dailyBudgetCents,
    updatedAt: row.updatedAt,
  }));
}

/** A set of ceilings summed, plus the campaigns it is made of. */
export interface CeilingSubtotal {
  dailyBudgetCents: string;
  updatedAt: Date;
  campaigns: CampaignBudgetTotal[];
}

function subtotalOf(rows: CeilingRow[]): CeilingSubtotal | null {
  if (rows.length === 0) return null;
  return {
    dailyBudgetCents: sumCeilings(rows),
    updatedAt: latestUpdatedAt(rows),
    campaigns: campaignTotalsOf(rows),
  };
}

/** One offer's ceiling (the SUM funding it), or null when it has none. */
export function aggregateOfferBudget(
  rows: CeilingRow[],
  offerId: string
): CeilingSubtotal | null {
  return subtotalOf(offerBudgetRows(rows, offerId));
}

/** One leg's ceiling (the SUM funding it), or null when it has none. */
export function aggregateLegBudget(
  rows: CeilingRow[],
  legKey: string
): CeilingSubtotal | null {
  return subtotalOf(legBudgetRows(rows, legKey));
}

/** One campaign's ceiling, or null when nothing funds it (never read as 0). */
export function campaignBudgetOf(
  rows: CeilingRow[],
  key: CampaignKey
): { dailyBudgetCents: string; updatedAt: Date } | null {
  const owned = campaignCeilingRows(rows, key);
  if (owned.length === 0) return null;
  return { dailyBudgetCents: sumCeilings(owned), updatedAt: latestUpdatedAt(owned) };
}

/** Channel slug, then offer, then leg (the unscoped one first), so a list renders stably. */
export function sortCeilings<R extends CeilingRow>(rows: R[]): R[] {
  return [...rows].sort(
    (a, b) =>
      a.featureSlug.localeCompare(b.featureSlug) ||
      (a.offerId ?? "").localeCompare(b.offerId ?? "") ||
      (a.legKey ?? "").localeCompare(b.legKey ?? "")
  );
}

/** Read EVERY stored ceiling of one org+brand. Empty when never set. */
export async function getBrandCeilings(
  orgId: string,
  brandId: string
): Promise<CeilingRow[]> {
  const rows = await db
    .select()
    .from(campaignDailyBudgets)
    .where(
      and(
        eq(campaignDailyBudgets.orgId, orgId),
        eq(campaignDailyBudgets.brandId, brandId)
      )
    );
  return sortCeilings(rows);
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
 * The rows `campaignCeilingRows` resolves as this campaign's are CONSOLIDATED:
 * one is kept (stamped with this campaign's offer and leg, set to the new
 * amount) and the rest deleted, so a campaign never holds two rows. When nothing
 * matches, a new row is opened.
 *
 * The channel's published floor applies to the channel's TOTAL across the brand
 * (see `assertChannelMeetsMinimum`). A superseded brand-level scalar is dropped
 * (the brand is ceiling-funded from now on) and one history row carrying the new
 * brand TOTAL is appended.
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
    throw new InvalidCeilingError(
      err instanceof Error ? err.message : "invalid dailyBudgetCents"
    );
  }

  // Read before the lock — a network read has no business inside one.
  const minimums = await getChannelMinimums();

  return db.transaction(async (tx) => {
    const changedAt = new Date();
    const whereBrand = and(
      eq(campaignDailyBudgets.orgId, orgId),
      eq(campaignDailyBudgets.brandId, brandId)
    );

    const existing = sortCeilings(
      await tx.select().from(campaignDailyBudgets).where(whereBrand).for("update")
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
    assertChannelMeetsMinimum(
      key.featureSlug,
      addCents(
        sumCeilings(channelRows.filter((row) => !ownedSet.has(row))),
        dailyBudgetCents
      ),
      channelRows.length > 0 ? sumCeilings(channelRows) : null,
      minimums
    );

    const previousBrandDailyBudgetCents =
      existing.length > 0
        ? sumCeilings(existing)
        : brandRow
          ? brandRow.dailyBudgetCents
          : null;

    const [keeper, ...rest] = owned;
    for (const row of rest) {
      await tx.delete(campaignDailyBudgets).where(identityOf(orgId, brandId, row));
    }
    if (keeper) {
      await tx
        .update(campaignDailyBudgets)
        .set({
          offerId: key.offerId,
          legKey: key.legKey,
          dailyBudgetCents,
          updatedAt: changedAt,
        })
        .where(identityOf(orgId, brandId, keeper));
    } else {
      await tx.insert(campaignDailyBudgets).values({
        orgId,
        brandId,
        featureSlug: key.featureSlug,
        offerId: key.offerId,
        legKey: key.legKey,
        dailyBudgetCents,
        updatedAt: changedAt,
      });
    }

    const ceilings = sortCeilings(
      await tx.select().from(campaignDailyBudgets).where(whereBrand)
    );
    const brandDailyBudgetCents = sumCeilings(ceilings);

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

/**
 * Match exactly one stored ceiling (every key column, nulls as values). An
 * unscoped offer or leg needs `IS NULL` — `= NULL` matches nothing.
 */
function identityOf(orgId: string, brandId: string, row: CeilingRow) {
  return and(
    eq(campaignDailyBudgets.orgId, orgId),
    eq(campaignDailyBudgets.brandId, brandId),
    eq(campaignDailyBudgets.featureSlug, row.featureSlug),
    row.offerId === null
      ? isNull(campaignDailyBudgets.offerId)
      : eq(campaignDailyBudgets.offerId, row.offerId),
    row.legKey === null
      ? isNull(campaignDailyBudgets.legKey)
      : eq(campaignDailyBudgets.legKey, row.legKey)
  );
}
