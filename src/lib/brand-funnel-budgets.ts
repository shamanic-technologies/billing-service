/**
 * Per-funnel, per-ACQUISITION-CHANNEL daily spending ceilings for a brand.
 *
 * A channel IS a features-service feature slug (`sales-cold-email-outreach`,
 * `sales-crm-email-outreach`, …) — there is no separate "channel" concept in the
 * fleet and none is introduced here. The same sales funnel can be worked through
 * two different offers at once (a straight sales pitch, a feedback-request
 * pitch); each (funnel, feature) pair runs its own campaign, is measured on its
 * own, and so must be paced and priced on its own money. Migration 0036 put the
 * feature slug in the key for exactly that.
 *
 * THE READS ARE SUMS, AND NOBODY ELSE ADDS ANYTHING UP. The per-funnel figure is
 * the sum of that funnel's pairs; the brand-wide figure is the sum of every
 * pair. A consumer that sums is a consumer that will disagree with this service
 * one day, so every grain it could want is served here.
 *
 * WHICH FEATURE MAY BE SOLD THROUGH WHICH FUNNEL IS NOT THIS SERVICE'S
 * STATEMENT. features-service owns the product taxonomy; billing stores whatever
 * slug the customer funds and never validates the pair against a list.
 *
 * A brand sells through several SALES FUNNELS — brand-service owns that
 * vocabulary and its four keys are `reply_meeting`, `visit_meeting`,
 * `visit_signup`, `visit_form`. Until this existed, everything a brand sold was
 * funded from ONE pot (brand_daily_budgets), so a customer selling both a $200
 * self-serve plan and a $20k contract could not say "spend $1/day chasing
 * purchases and $24/day chasing meetings".
 *
 * THE LOAD-BEARING INVARIANT: the brand-level daily budget keeps its current
 * shape and answers the SUM of these ceilings. The launch gate, the credit-runway
 * warnings, the credit alerts, the brand Overview tile and campaign-service's
 * budget propagation all read that number today, and none of them changes. No
 * consumer re-composes the sum itself — that is how two surfaces start
 * disagreeing about the same number.
 *
 * NO BACKFILL for a brand selling through SEVERAL funnels. Splitting an existing
 * budget across them would invent numbers the customer never stated, so such a
 * brand keeps its brand_daily_budgets row as the authoritative value and behaves
 * exactly as it does today. That rule never covered a brand selling through
 * exactly ONE funnel — there the whole ceiling belongs to that funnel by
 * construction, and recording it is an attribution rather than a split. See
 * `single-funnel-attribution.ts`.
 *
 * ONE CAMPAIGN, ONE ROW. A ceiling that names an offer, written onto a pair
 * whose only stored ceiling is the pre-offer unscoped one, REPLACES it: the
 * customer stated one ceiling for that campaign, and the per-funnel figure is a
 * SUM, so two rows for it would count their money twice. See
 * `supersededUnscopedRows` - the mirror of `resolveEntryOfferId`, which already
 * reads that unscoped ceiling as the pair's only offer when the caller names
 * none.
 *
 * The two states are mutually exclusive by construction: the first per-funnel
 * write DELETES the superseded brand-level row (in the same transaction), and
 * PATCH /v1/brands/:brandId/daily-budget refuses (409) to write a brand that is
 * funnel-funded. So there is never a stale scalar sitting beside the ceilings
 * that could disagree with their sum.
 *
 * Fail-loud: any DB error propagates.
 */

import { and, eq, isNull } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import {
  brandDailyBudgets,
  brandDailyBudgetChanges,
  brandFunnelDailyBudgets,
  type BrandFunnelDailyBudget,
} from "../db/schema.js";
import { addCents, parseNonNegativeCents } from "./cents.js";

/**
 * The sales-funnel keys billing STORES, one row per funnel per org+brand.
 *
 * These are brand-service's pre-retirement spellings. brand-service has since
 * renamed its four keys and now EMITS only the canonical ones, while accepting
 * these forever; the dashboard reads both and collapses them onto these. So
 * these stay the stored form — a ceiling is only useful if the screen that
 * renders it and the store agree on which funnel it belongs to.
 */
export const BRAND_FUNNEL_KEYS = [
  "reply_meeting",
  "visit_meeting",
  "visit_signup",
  "visit_form",
] as const;

export type BrandFunnelKey = (typeof BRAND_FUNNEL_KEYS)[number];

export function isBrandFunnelKey(value: string): value is BrandFunnelKey {
  return (BRAND_FUNNEL_KEYS as readonly string[]).includes(value);
}

/**
 * Every OTHER spelling a caller may send for the same funnel: brand-service's
 * canonical four.
 *
 * ACCEPTED ON WRITE, resolved to the stored key. Never emitted — every read
 * still answers with the stored spelling, so no consumer changes.
 *
 * Two reasons this is not cosmetic:
 *
 *   - a caller sending the canonical word today gets a 400 "Unknown sales
 *     funnel". The dashboard sends the stored spellings, so nothing breaks
 *     right now — but it already READS both, ahead of its own catalogue
 *     flipping, and the day it writes what it reads every ceiling write on this
 *     service starts failing. Accepting both is what made the rename safe on
 *     brand-service's side, for exactly the same reason;
 *   - more sharply, the two spellings name ONE funnel while the primary key
 *     treats them as two. Without resolution, `form_magnet` and `visit_form`
 *     could both be stored for one brand and the brand-level read — which
 *     answers the SUM of the ceilings — would silently DOUBLE. Resolving on
 *     write makes that unrepresentable.
 */
export const ACCEPTED_FUNNEL_KEY_ALIASES: Record<string, BrandFunnelKey> = {
  sales_meetings_from_conversation: "reply_meeting",
  sales_meetings_from_website: "visit_meeting",
  website_purchases: "visit_signup",
  form_magnet: "visit_form",
};

/**
 * Resolve any accepted spelling onto the stored key, or null if it names no
 * funnel we know. Callers turn the null into a 400 quoting every accepted word.
 */
export function toStoredFunnelKey(value: string): BrandFunnelKey | null {
  if (isBrandFunnelKey(value)) return value;
  return ACCEPTED_FUNNEL_KEY_ALIASES[value] ?? null;
}

/** Every spelling accepted on write, for error messages. */
export const ACCEPTED_FUNNEL_KEYS: readonly string[] = [
  ...BRAND_FUNNEL_KEYS,
  ...Object.keys(ACCEPTED_FUNNEL_KEY_ALIASES),
];

/** Customer-facing funnel names, for error messages a person can read. */
export const BRAND_FUNNEL_LABELS: Record<BrandFunnelKey, string> = {
  reply_meeting: "Sales Meeting (reply)",
  visit_meeting: "Sales Meeting (visit)",
  visit_signup: "Website Purchase",
  visit_form: "Form Magnet",
};

/**
 * Product minimum per funded funnel, in cents/day. A funnel at 0 is NOT funded
 * and is always accepted — that is how a customer pauses one, and a set where
 * EVERY funnel is 0 is a brand in pause, not an error. ("At least one funded
 * funnel" belongs to the checkout that spends money, not to storage: enforcing
 * it here would make it impossible to pause everything from settings.)
 *
 * The minimum governs what a customer may NEWLY STATE, not what one has already
 * been running — see `assertFundedFunnelMeetsMinimum`.
 */
export const BRAND_FUNNEL_MIN_DAILY_BUDGET_CENTS: Record<
  BrandFunnelKey,
  number
> = {
  visit_signup: 100, // $1/day
  visit_form: 100, // $1/day
  reply_meeting: 2400, // $24/day
  visit_meeting: 2400, // $24/day
};

/** A ceiling below its funnel's product minimum. Surfaced as a 400. */
export class FunnelBudgetBelowMinimumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FunnelBudgetBelowMinimumError";
  }
}

/** An unknown funnel key, or the same key twice in one set. Surfaced as a 400. */
export class InvalidFunnelSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFunnelSetError";
  }
}

/**
 * A funnel-grain write against a funnel that is funded through SEVERAL
 * acquisition channels. Surfaced as a 409 — the funnel's figure is derived from
 * its channels there, exactly as the brand's figure is derived from its funnels,
 * so the caller must say which channel it is funding.
 */
export class FunnelSplitAcrossChannelsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FunnelSplitAcrossChannelsError";
  }
}

/**
 * A (funnel, channel)-grain write against a pair that is funded for SEVERAL
 * offers. Surfaced as a 409, the same posture as the two refusals above: the
 * figure the caller addressed is derived one level down, and picking one of two
 * offers would move the money onto the wrong campaign.
 */
export class ChannelSplitAcrossOffersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelSplitAcrossOffersError";
  }
}

/**
 * A brand-level daily-budget write against a brand that is funded per funnel.
 * Surfaced as a 409 — the brand-level value is DERIVED there, so accepting the
 * write would leave two numbers claiming to be the same thing.
 */
export class BrandBudgetManagedByFunnelsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandBudgetManagedByFunnelsError";
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

/**
 * The acquisition channel a ceiling funds when the caller names none.
 *
 * Every existing caller — the signup checkout, brand Settings, the gateway —
 * speaks per FUNNEL and knows nothing about channels, and must keep working
 * unchanged. A slug-less write is therefore resolved against what the funnel is
 * already funding (see `resolveEntryFeatureSlug`), and falls back to this only
 * when the funnel funds NOTHING yet. It is the channel every brand in the fleet
 * runs today bar one, and the one exception is already recorded by migration
 * 0036 — so a legacy write can neither invent a second channel for a funnel nor
 * silently move money onto the wrong one.
 */
export const DEFAULT_ACQUISITION_CHANNEL_FEATURE_SLUG =
  "sales-cold-email-outreach";

export interface FunnelBudgetInput {
  funnelKey: string;
  /**
   * The acquisition-channel feature slug this ceiling funds. OPTIONAL: a caller
   * that speaks per funnel only (every caller before 0036) omits it and the
   * funnel's existing channel is used.
   */
  featureSlug?: unknown;
  /**
   * The OFFER this ceiling funds, a brand-service offer UUID (migration 0037).
   * OPTIONAL: a caller that speaks per (funnel, channel) only (every caller
   * before 0037) omits it and the pair's existing offer is used.
   */
  offerId?: unknown;
  dailyBudgetCents: unknown;
}

export interface ParsedFunnelBudget {
  funnelKey: BrandFunnelKey;
  /** null = "whatever channel this funnel already funds", resolved under the lock. */
  featureSlug: string | null;
  /**
   * The offer the caller named, or `undefined` when it named none — resolved
   * under the write lock against what the pair already funds.
   *
   * `undefined` and `null` are DIFFERENT here, which is why this is an optional
   * property rather than a nullable one: `undefined` means "the caller said
   * nothing about offers", while `null` is a stored value meaning "this ceiling
   * is not scoped to an offer" (every ceiling written before 0037).
   */
  offerId?: string;
  dailyBudgetCents: string;
}

/** A stored ceiling's offer after resolution: an offer UUID, or unscoped. */
export type ResolvedOfferId = string | null;

const OFFER_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse one whole set BEFORE anything is written: resolve every spelling onto
 * its stored key, refuse a duplicate funnel, and read each amount as
 * non-negative cents. Throws on the first problem, so a rejected set leaves
 * nothing half-applied (the caller has not opened a transaction yet).
 *
 * The product MINIMUM is deliberately NOT checked here. Whether a sub-minimum
 * value is legal depends on the funnel's own STORED ceiling (grandfathering),
 * which is only trustworthy under the write lock — so that check runs inside the
 * write transaction, in `setBrandFunnelDailyBudgets`. It throws the same error
 * type, and a throw there rolls the transaction back, so a refused write still
 * leaves nothing half-applied.
 */
export function parseFunnelBudgetSet(
  entries: FunnelBudgetInput[]
): ParsedFunnelBudget[] {
  const parsed: ParsedFunnelBudget[] = [];

  for (const entry of entries) {
    const funnelKey =
      typeof entry?.funnelKey === "string"
        ? toStoredFunnelKey(entry.funnelKey)
        : null;
    if (!funnelKey) {
      throw new InvalidFunnelSetError(
        `Unknown sales funnel "${String(entry?.funnelKey)}". Valid funnels: ${ACCEPTED_FUNNEL_KEYS.join(", ")}.`
      );
    }

    let featureSlug: string | null = null;
    if (entry.featureSlug !== undefined && entry.featureSlug !== null) {
      if (typeof entry.featureSlug !== "string" || !entry.featureSlug.trim()) {
        throw new InvalidFunnelSetError(
          `${BRAND_FUNNEL_LABELS[funnelKey]}: featureSlug must be a non-empty acquisition-channel feature slug.`
        );
      }
      featureSlug = entry.featureSlug.trim();
    }

    // The OFFER, when the caller named one. Format-checked only: brand-service
    // owns the entity, and billing validates the offer against it no more than
    // it validates the channel slug against features-service.
    let offerId: string | undefined;
    if (entry.offerId !== undefined && entry.offerId !== null) {
      if (
        typeof entry.offerId !== "string" ||
        !OFFER_UUID_RE.test(entry.offerId.trim())
      ) {
        throw new InvalidFunnelSetError(
          `${BRAND_FUNNEL_LABELS[funnelKey]}: offerId must be a valid offer UUID.`
        );
      }
      offerId = entry.offerId.trim().toLowerCase();
    }

    // Deduped on the RESOLVED funnel + channel + offer, so the two spellings of
    // one funnel are one funnel here too - otherwise a set carrying both would
    // store two rows for the same pair and double the brand-level total.
    //
    // A slug-less entry addresses one funnel AS A WHOLE, so it can appear only
    // once for that funnel and never beside a channel-named entry for it. An
    // offer-less entry addresses one (funnel, channel) pair as a whole, and the
    // same rule applies one level down: a set stating a pair both with and
    // without an offer is asking for two ceilings whose grains overlap.
    const sameFunnel = parsed.filter((p) => p.funnelKey === funnelKey);
    if (
      sameFunnel.some(
        (p) => p.featureSlug === featureSlug && p.offerId === offerId
      )
    ) {
      throw new InvalidFunnelSetError(
        featureSlug
          ? `Sales funnel "${funnelKey}" appears twice for channel "${featureSlug}"${offerId ? ` and offer "${offerId}"` : ""} in the same set.`
          : `Sales funnel "${funnelKey}" appears twice in the same set.`
      );
    }
    if (
      sameFunnel.some((p) => (p.featureSlug === null) !== (featureSlug === null))
    ) {
      throw new InvalidFunnelSetError(
        `Sales funnel "${funnelKey}" is set both with and without an acquisition channel in the same set.`
      );
    }
    if (
      sameFunnel.some(
        (p) =>
          p.featureSlug === featureSlug &&
          (p.offerId === undefined) !== (offerId === undefined)
      )
    ) {
      throw new InvalidFunnelSetError(
        `Sales funnel "${funnelKey}" on acquisition channel "${featureSlug}" is set both with and without an offer in the same set.`
      );
    }

    let dailyBudgetCents: string;
    try {
      dailyBudgetCents = parseNonNegativeCents(entry.dailyBudgetCents);
    } catch (err) {
      throw new InvalidFunnelSetError(
        `${BRAND_FUNNEL_LABELS[funnelKey]}: ${
          err instanceof Error ? err.message : "invalid dailyBudgetCents"
        }`
      );
    }

    // `offerId` is spread rather than assigned so an unstated offer leaves the
    // property ABSENT, which is what distinguishes it from a stored null.
    parsed.push({
      funnelKey,
      featureSlug,
      dailyBudgetCents,
      ...(offerId === undefined ? {} : { offerId }),
    });
  }

  return parsed;
}

/**
 * A funnel that IS funded has a product minimum, and the minimum binds the
 * FUNNEL TOTAL — the sum of every acquisition channel funding it — never a
 * single pair. A customer splitting one funded funnel across two channels
 * ($30 + $20 on a $24/day funnel) must not be refused because each half is under
 * a floor the whole clears; that split changes nothing about what the funnel
 * spends per day, which is the only thing the minimum is about.
 *
 * Zero is exempt — a funnel whose channels all sit at 0 is "not funding that
 * funnel right now", which is an ordinary state.
 *
 * GRANDFATHERING. The minimum polices what a customer may NEWLY STATE, not what
 * one has already been running. Ceilings predating the minimum were carried over
 * verbatim by the single-funnel attribution sweep — deliberately, because they
 * are the money the brand is actually spending — so live brands sit below their
 * funnel's floor today. Refusing every write of such a ceiling leaves its owner
 * only two moves: leave it exactly alone, or defund it to zero. Raising it
 * TOWARDS the floor would be refused, which is the wrong direction to block.
 *
 * So a funnel whose STORED ceiling is above zero and below its minimum may be
 * re-stated or RAISED to any higher value, including one still below the
 * minimum. It may not be LOWERED to another funded sub-minimum value: that is a
 * new statement below the floor, which is exactly what the minimum exists to
 * refuse. Zero is always accepted (defunding is never blocked).
 *
 * The grandfather is spent the moment the ceiling reaches its minimum — that
 * falls out of the ordinary check below rather than needing its own branch,
 * since a stored value at or above the minimum never enters the grandfather
 * clause. It is derived from the stored ceiling and nothing else: no flag, no
 * column, no per-org override.
 *
 * The grandfather cannot silently re-open: it is read off the STORED TOTAL, so a
 * funnel already at or above its floor never enters the clause, whatever the
 * split underneath looks like.
 *
 * `storedDailyBudgetCents` is this funnel's OWN current TOTAL across its channels
 * (null when it funds none), read under the write lock. Each funnel is judged
 * against its own, so one grandfathered funnel in a set never licenses a
 * sub-minimum value on another.
 */
export function assertFundedFunnelMeetsMinimum(
  funnelKey: BrandFunnelKey,
  dailyBudgetCents: string,
  storedDailyBudgetCents: string | null = null
): void {
  const value = new Decimal(dailyBudgetCents);
  if (value.isZero()) return;

  const minimum = BRAND_FUNNEL_MIN_DAILY_BUDGET_CENTS[funnelKey];
  if (value.greaterThanOrEqualTo(minimum)) return;

  const stored =
    storedDailyBudgetCents === null ? null : new Decimal(storedDailyBudgetCents);
  const grandfathered =
    stored !== null && stored.greaterThan(0) && stored.lessThan(minimum);

  if (grandfathered) {
    if (value.greaterThanOrEqualTo(stored)) return;
    throw new FunnelBudgetBelowMinimumError(
      `${BRAND_FUNNEL_LABELS[funnelKey]} is funded at ${dollarsPerDay(stored.toString())}, below the ${dollarsPerDay(minimum)} this funnel now needs to run. You can keep it at ${dollarsPerDay(stored.toString())}, raise it, or set it to 0 to stop funding it — you set ${dollarsPerDay(dailyBudgetCents)}.`
    );
  }

  throw new FunnelBudgetBelowMinimumError(
    `${BRAND_FUNNEL_LABELS[funnelKey]} needs at least ${dollarsPerDay(minimum)} to run — you set ${dollarsPerDay(dailyBudgetCents)}. Set it to 0 if you do not want to fund this funnel right now.`
  );
}

/** Sum of a set of ceilings, canonical fixed-scale string. */
export function sumFunnelBudgets(
  rows: Array<{ dailyBudgetCents: string }>
): string {
  return rows.reduce(
    (total, row) => addCents(total, row.dailyBudgetCents),
    "0.0000000000"
  );
}

/** One funnel's figure: the SUM of every acquisition channel funding it. */
export interface FunnelBudgetTotal {
  funnelKey: string;
  dailyBudgetCents: string;
  updatedAt: Date;
}

/**
 * Collapse per-channel rows onto the per-FUNNEL figure every existing consumer
 * asks for. This is the ONLY place that sum is composed for the funnel grain —
 * a consumer that adds the channels up itself is a consumer that will one day
 * disagree with this service.
 *
 * `updatedAt` is the latest of the funnel's channels, so the funnel's timestamp
 * moves whenever anything funding it moves. A brand that has never split
 * anything has one channel per funnel, so both figures are byte-identical to
 * what this service served before 0036.
 */
export function aggregateFunnelTotals(
  rows: BrandFunnelDailyBudget[]
): FunnelBudgetTotal[] {
  const byFunnel = new Map<string, FunnelBudgetTotal>();
  for (const row of rows) {
    const current = byFunnel.get(row.funnelKey);
    if (!current) {
      byFunnel.set(row.funnelKey, {
        funnelKey: row.funnelKey,
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
  return sortByFunnelOrderOf([...byFunnel.values()], (t) => t.funnelKey);
}

/** One (funnel, channel) pair's figure: the SUM of every offer funding it. */
export interface ChannelBudgetTotal {
  funnelKey: string;
  featureSlug: string;
  dailyBudgetCents: string;
  updatedAt: Date;
}

/**
 * Collapse per-OFFER rows onto the per-CHANNEL figure migration 0036's consumers
 * ask for. Same rule as `aggregateFunnelTotals` one level down, and the ONLY
 * place that sum is composed: a brand that has never funded an offer holds one
 * row per pair, so this is byte-identical to what shipped before 0037.
 */
export function aggregateChannelTotals(
  rows: BrandFunnelDailyBudget[]
): ChannelBudgetTotal[] {
  const byPair = new Map<string, ChannelBudgetTotal>();
  for (const row of rows) {
    const key = `${row.funnelKey} ${row.featureSlug}`;
    const current = byPair.get(key);
    if (!current) {
      byPair.set(key, {
        funnelKey: row.funnelKey,
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
  return sortByFunnelOrderOf(
    [...byPair.values()].sort((a, b) =>
      a.featureSlug.localeCompare(b.featureSlug)
    ),
    (t) => t.funnelKey
  );
}

/** One funnel's current total across its channels, "0" when it funds none. */
export function funnelTotalOf(
  rows: Array<{ funnelKey: string; dailyBudgetCents: string }>,
  funnelKey: string
): string {
  return sumFunnelBudgets(rows.filter((row) => row.funnelKey === funnelKey));
}

/**
 * Read one org's per-channel ceilings for a brand, one row per
 * (funnel, acquisition-channel feature). Empty when never set.
 */
export async function getBrandFunnelDailyBudgets(
  orgId: string,
  brandId: string
): Promise<BrandFunnelDailyBudget[]> {
  const rows = await db
    .select()
    .from(brandFunnelDailyBudgets)
    .where(
      and(
        eq(brandFunnelDailyBudgets.orgId, orgId),
        eq(brandFunnelDailyBudgets.brandId, brandId)
      )
    );
  return sortByFunnelOrder(rows);
}

/** Stable, product-meaningful order (BRAND_FUNNEL_KEYS), not insertion order. */
function sortByFunnelOrderOf<T>(rows: T[], keyOf: (row: T) => string): T[] {
  const order = new Map<string, number>(
    BRAND_FUNNEL_KEYS.map((key, i) => [key as string, i])
  );
  return [...rows].sort(
    (a, b) =>
      (order.get(keyOf(a)) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(keyOf(b)) ?? Number.MAX_SAFE_INTEGER)
  );
}

/**
 * Funnel order first, then channel slug, then offer (the unscoped ceiling first,
 * since it is the one that predates offers), so a split renders stably.
 */
function sortByFunnelOrder(
  rows: BrandFunnelDailyBudget[]
): BrandFunnelDailyBudget[] {
  return sortByFunnelOrderOf(
    [...rows].sort(
      (a, b) =>
        a.featureSlug.localeCompare(b.featureSlug) ||
        (a.offerId ?? "").localeCompare(b.offerId ?? "")
    ),
    (row) => row.funnelKey
  );
}

export interface SetFunnelBudgetsResult {
  /**
   * Every STORED ceiling after the write, one per
   * (funnel, acquisition channel, offer) - i.e. one per campaign.
   */
  offers: BrandFunnelDailyBudget[];
  /** The per-CHANNEL figures, each the sum of the offers funding that pair. */
  channels: ChannelBudgetTotal[];
  /** The per-FUNNEL figures, each the sum of its channels. */
  funnels: FunnelBudgetTotal[];
  /**
   * The brand-level daily budget BEFORE this write — the funnel sum if this
   * brand was already funnel-funded, else its brand-level scalar, else null
   * (never configured). Read inside the write transaction.
   */
  previousBrandDailyBudgetCents: string | null;
  /** The brand-level daily budget AFTER this write = the sum of the ceilings. */
  brandDailyBudgetCents: string;
}

/**
 * Write per-funnel ceilings for one org+brand, atomically.
 *
 * `mode`:
 *   - `"replace"` — the whole set at once (signup checkout). Funnels absent from
 *     `entries` are DELETED, so the stored set is exactly what was sent.
 *   - `"merge"` — one funnel at a time (brand Settings). Untouched funnels keep
 *     their ceiling.
 *
 * Shape and amounts are validated by the CALLER (parseFunnelBudgetSet) before
 * the transaction opens. The product MINIMUM is checked HERE instead, per
 * funnel, against that funnel's own currently-stored ceiling read under the same
 * lock — a sub-minimum ceiling that predates the minimum may be kept or raised
 * (see `assertFundedFunnelMeetsMinimum`), and that decision is only sound
 * against a locked read. A refusal throws before anything is written and rolls
 * the transaction back, so a rejected set still leaves nothing half-applied.
 *
 * Inside the transaction we also:
 *   - DELETE the superseded brand_daily_budgets row, so the brand-level scalar
 *     and the ceilings can never both exist and disagree;
 *   - append ONE brand_daily_budget_changes row carrying the NEW brand-level
 *     total, so the existing history timeline stays the timeline of the same
 *     number the brand-level read serves.
 *
 * (A brand with no rows yet has nothing to lock, so two concurrent first-ever
 * writes for one org+brand would both report the "from" side as unset. The
 * stored values still resolve correctly via ON CONFLICT — same accepted race as
 * the brand-level write.)
 */
export async function setBrandFunnelDailyBudgets(
  orgId: string,
  brandId: string,
  entries: ParsedFunnelBudget[],
  mode: "replace" | "merge"
): Promise<SetFunnelBudgetsResult> {
  return db.transaction(async (tx) => {
    const changedAt = new Date();

    const existingFunnels = await tx
      .select()
      .from(brandFunnelDailyBudgets)
      .where(
        and(
          eq(brandFunnelDailyBudgets.orgId, orgId),
          eq(brandFunnelDailyBudgets.brandId, brandId)
        )
      )
      .for("update");

    const [existingBrandRow] = await tx
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

    // Each funnel is judged against ITS OWN stored ceiling, so one
    // grandfathered funnel in a set never licenses a sub-minimum value on
    // another. A funnel with no stored ceiling gets the plain minimum.
    // A slug-less entry (every caller before 0036 speaks per funnel only) is
    // resolved against what the funnel already funds, so a legacy write can
    // never open a SECOND channel beside the one carrying the brand's money.
    const resolved = entries.map((entry) => {
      const featureSlug = resolveEntryFeatureSlug(entry, existingFunnels);
      return {
        ...entry,
        featureSlug,
        // An offer-less entry (every caller before 0037 speaks per funnel and
        // channel only) is resolved against what the PAIR already funds, so a
        // legacy write can neither invent an offer nor silently move money onto
        // one of two campaigns.
        offerId: resolveEntryOfferId(entry, featureSlug, existingFunnels),
      };
    });

    // A ceiling that NAMES an offer, written onto a pair whose only stored
    // ceiling is the pre-offer unscoped one, ADOPTS that ceiling rather than
    // sitting beside it - see `supersededUnscopedRows`.
    const superseded = supersededUnscopedRows(existingFunnels, resolved);

    // The minimum binds the FUNNEL TOTAL, so it is judged on what each touched
    // funnel will sum to after this write, against what it sums to now.
    const projected = projectFunnelRows(
      existingFunnels,
      resolved,
      mode,
      superseded
    );
    for (const funnelKey of new Set(resolved.map((e) => e.funnelKey))) {
      const storedTotal = existingFunnels.some(
        (row) => row.funnelKey === funnelKey
      )
        ? funnelTotalOf(existingFunnels, funnelKey)
        : null;
      assertFundedFunnelMeetsMinimum(
        funnelKey,
        funnelTotalOf(projected, funnelKey),
        storedTotal
      );
    }

    const previousBrandDailyBudgetCents =
      existingFunnels.length > 0
        ? sumFunnelBudgets(existingFunnels)
        : existingBrandRow
          ? existingBrandRow.dailyBudgetCents
          : null;

    // In "replace" the stored set is exactly what was sent, so any ceiling
    // absent from the body goes - including an offer of a (funnel, channel)
    // pair that IS in the body, and a channel of a funnel that is. That already
    // removes an adopted unscoped ceiling, so only "merge" has to delete it.
    const keep = new Set(resolved.map((e) => rowIdentity(e)));
    const toDelete =
      mode === "replace"
        ? existingFunnels.filter((row) => !keep.has(rowIdentity(row)))
        : superseded;
    for (const row of toDelete) {
      await tx
        .delete(brandFunnelDailyBudgets)
        .where(
          and(
            eq(brandFunnelDailyBudgets.orgId, orgId),
            eq(brandFunnelDailyBudgets.brandId, brandId),
            eq(brandFunnelDailyBudgets.funnelKey, row.funnelKey),
            eq(brandFunnelDailyBudgets.featureSlug, row.featureSlug),
            offerMatches(row.offerId)
          )
        );
    }

    for (const entry of resolved) {
      await tx
        .insert(brandFunnelDailyBudgets)
        .values({
          orgId,
          brandId,
          funnelKey: entry.funnelKey,
          featureSlug: entry.featureSlug,
          offerId: entry.offerId,
          dailyBudgetCents: entry.dailyBudgetCents,
          updatedAt: changedAt,
        })
        // Inference resolves to the NULLS NOT DISTINCT unique constraint of
        // migration 0037, so an unscoped ceiling (offer_id IS NULL) upserts in
        // place exactly as it did when the four columns were the primary key.
        .onConflictDoUpdate({
          target: [
            brandFunnelDailyBudgets.orgId,
            brandFunnelDailyBudgets.brandId,
            brandFunnelDailyBudgets.funnelKey,
            brandFunnelDailyBudgets.featureSlug,
            brandFunnelDailyBudgets.offerId,
          ],
          set: {
            dailyBudgetCents: entry.dailyBudgetCents,
            updatedAt: changedAt,
          },
        });
    }

    const offers = sortByFunnelOrder(
      await tx
        .select()
        .from(brandFunnelDailyBudgets)
        .where(
          and(
            eq(brandFunnelDailyBudgets.orgId, orgId),
            eq(brandFunnelDailyBudgets.brandId, brandId)
          )
        )
    );
    const channels = aggregateChannelTotals(offers);
    const funnels = aggregateFunnelTotals(offers);

    const brandDailyBudgetCents = sumFunnelBudgets(offers);

    // The brand-level scalar is now DERIVED. Drop the superseded row so it can
    // never be served instead of the sum.
    if (existingBrandRow) {
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

    return {
      offers,
      channels,
      funnels,
      previousBrandDailyBudgetCents,
      brandDailyBudgetCents,
    };
  });
}

/**
 * Which acquisition channel does this entry fund?
 *
 * A caller that named one is taken at its word — billing does not hold the
 * product taxonomy, so it never asks whether that feature may be sold through
 * that funnel.
 *
 * A caller that named none means "this funnel", the only grain that existed
 * before 0036. It resolves to:
 *   - the funnel's single channel, when it funds exactly one (every live brand
 *     today, so brand Settings and the signup checkout keep working untouched);
 *   - the default channel, when the funnel funds none yet (a first-ever write);
 *   - a refusal, when the funnel is SPLIT across channels — there is no honest
 *     way to guess which of two campaigns the customer meant to re-fund, and
 *     silently picking one would move money onto the wrong offer.
 */
function resolveEntryFeatureSlug(
  entry: ParsedFunnelBudget,
  existing: BrandFunnelDailyBudget[]
): string {
  if (entry.featureSlug) return entry.featureSlug;

  // When the caller DID name an offer, the funnel's channels are read for that
  // offer first: a brand running two channels under one funnel, one per offer,
  // has exactly one honest answer there, and refusing it would be an
  // over-refusal rather than a guess. With no rows for that offer we fall back
  // to the funnel's channels as a whole, which is the pre-0037 rule verbatim -
  // so a caller that names no offer follows exactly the path it always did.
  const forOffer = entry.offerId
    ? existing.filter(
        (row) =>
          row.funnelKey === entry.funnelKey && row.offerId === entry.offerId
      )
    : [];
  const scope =
    forOffer.length > 0
      ? forOffer
      : existing.filter((row) => row.funnelKey === entry.funnelKey);

  const channels = [...new Set(scope.map((row) => row.featureSlug))];
  if (channels.length === 0) return DEFAULT_ACQUISITION_CHANNEL_FEATURE_SLUG;
  if (channels.length === 1) return channels[0];

  throw new FunnelSplitAcrossChannelsError(
    `${BRAND_FUNNEL_LABELS[entry.funnelKey]} is funded through ${channels.length} acquisition channels (${channels.join(", ")}). ` +
      `Name the one you are funding - setting the funnel as a whole would have to guess which campaign the money is for.`
  );
}

/**
 * Which OFFER does this entry fund?
 *
 * A caller that named one is taken at its word: brand-service owns the offer
 * entity, so billing no more asks whether that offer exists than it asks whether
 * a feature may be sold through a funnel.
 *
 * A caller that named none means "this (funnel, channel) pair", the finest grain
 * that existed before 0037. It resolves to:
 *   - the pair's single offer, when it funds exactly one - and for every ceiling
 *     written before 0037 that is the UNSCOPED one (`null`), so brand Settings,
 *     the signup checkout and the gateway keep behaving exactly as they do now;
 *   - `null` (unscoped), when the pair funds nothing yet. There is deliberately
 *     no default offer to fall back to, the way there is a default channel: an
 *     offer id is brand-service's to state and inventing one would attach money
 *     to a campaign nobody named;
 *   - a refusal, when the pair is SPLIT across offers - the same posture the
 *     channel resolution takes one level up, because picking one of two offers
 *     moves real money onto the wrong campaign.
 */
function resolveEntryOfferId(
  entry: ParsedFunnelBudget,
  featureSlug: string,
  existing: BrandFunnelDailyBudget[]
): ResolvedOfferId {
  if (entry.offerId !== undefined) return entry.offerId;

  const offers = [
    ...new Set(
      existing
        .filter(
          (row) =>
            row.funnelKey === entry.funnelKey && row.featureSlug === featureSlug
        )
        .map((row) => row.offerId)
    ),
  ];
  if (offers.length === 0) return null;
  if (offers.length === 1) return offers[0];

  throw new ChannelSplitAcrossOffersError(
    `${BRAND_FUNNEL_LABELS[entry.funnelKey]} on acquisition channel "${featureSlug}" is funded for ${offers.length} offers ` +
      `(${offers.map((id) => id ?? "no offer").join(", ")}). ` +
      `Name the offer you are funding - setting the channel as a whole would have to guess which campaign the money is for.`
  );
}

/**
 * The stored UNSCOPED ceilings this write ADOPTS - the mirror of
 * `resolveEntryOfferId`, and the rule that keeps one campaign to one row.
 *
 * That resolution already reads an unscoped ceiling as the money of the pair's
 * only offer: a caller naming no offer updates it in place rather than opening a
 * second row. The mirror had to hold too. A ceiling written before 0037 is the
 * whole of what that (funnel, channel) pair is funded at, and the pair funds one
 * campaign, so when the offer-scoped settings page names the offer that campaign
 * belongs to, it is RE-STATING that same ceiling - not adding a second one
 * beside it. Without this the pair holds both, and the per-funnel figure (a SUM)
 * counts the customer's money twice: exactly what put one live brand at $90/day
 * on $50 of funding, with its two settings fields each showing the right amount.
 *
 * ONLY when the unscoped row is the pair's SOLE ceiling. A pair already split
 * across named offers has no unambiguous owner for an unscoped remainder, and
 * guessing one would move real money onto the wrong campaign - the same reason
 * `resolveEntryOfferId` refuses there rather than picking.
 *
 * The offer-LESS path is untouched: an entry that names no offer resolves to the
 * unscoped row and updates it, so no caller predating 0037 changes behaviour.
 */
function supersededUnscopedRows(
  existing: BrandFunnelDailyBudget[],
  resolved: Array<{
    funnelKey: BrandFunnelKey;
    featureSlug: string;
    offerId: ResolvedOfferId;
  }>
): BrandFunnelDailyBudget[] {
  return existing.filter((row) => {
    if (row.offerId !== null) return false;

    const pair = existing.filter(
      (other) =>
        other.funnelKey === row.funnelKey &&
        other.featureSlug === row.featureSlug
    );
    if (pair.length !== 1) return false;

    return resolved.some(
      (entry) =>
        entry.offerId !== null &&
        entry.funnelKey === row.funnelKey &&
        entry.featureSlug === row.featureSlug
    );
  });
}

/** A stored ceiling's identity: one (funnel, channel, offer) = one campaign. */
function rowIdentity(row: {
  funnelKey: string;
  featureSlug: string;
  offerId: ResolvedOfferId;
}): string {
  return `${row.funnelKey}\u0000${row.featureSlug}\u0000${row.offerId ?? ""}`;
}

/**
 * Match one ceiling's offer in a WHERE clause. An unscoped ceiling needs
 * `IS NULL` - `= NULL` matches nothing, which would silently leave the row that
 * a replace-mode write is supposed to delete.
 */
function offerMatches(offerId: ResolvedOfferId) {
  return offerId === null
    ? isNull(brandFunnelDailyBudgets.offerId)
    : eq(brandFunnelDailyBudgets.offerId, offerId);
}

/**
 * What the stored rows will look like after this write - computed BEFORE
 * anything is written, so the funnel-total minimum is judged on the outcome
 * rather than on one ceiling in isolation.
 *
 * An ADOPTED unscoped ceiling is gone after this write, so it is not projected:
 * counting it would judge the minimum against a total this write is precisely
 * removing, and read $40 replaced by $40 as $80.
 */
function projectFunnelRows(
  existing: BrandFunnelDailyBudget[],
  resolved: Array<{
    funnelKey: BrandFunnelKey;
    featureSlug: string;
    offerId: ResolvedOfferId;
    dailyBudgetCents: string;
  }>,
  mode: "replace" | "merge",
  superseded: BrandFunnelDailyBudget[] = []
): Array<{ funnelKey: string; featureSlug: string; dailyBudgetCents: string }> {
  const written = new Set(resolved.map((entry) => rowIdentity(entry)));
  const dropped = new Set(superseded.map((row) => rowIdentity(row)));
  const kept =
    mode === "replace"
      ? []
      : existing.filter(
          (row) =>
            !written.has(rowIdentity(row)) && !dropped.has(rowIdentity(row))
        );
  return [
    ...kept.map((row) => ({
      funnelKey: row.funnelKey,
      featureSlug: row.featureSlug,
      dailyBudgetCents: row.dailyBudgetCents,
    })),
    ...resolved,
  ];
}

/** True when this org+brand is funded per funnel (so the scalar is derived). */
export async function isFunnelFunded(
  orgId: string,
  brandId: string
): Promise<boolean> {
  const rows = await db
    .select({ funnelKey: brandFunnelDailyBudgets.funnelKey })
    .from(brandFunnelDailyBudgets)
    .where(
      and(
        eq(brandFunnelDailyBudgets.orgId, orgId),
        eq(brandFunnelDailyBudgets.brandId, brandId)
      )
    )
    .limit(1);
  return rows.length > 0;
}
