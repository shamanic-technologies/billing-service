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
 * AND THE OFFER GRAIN IS SERVED TOO, on its own read. An offer-scoped screen
 * paces one proposition against the money funding it, which is neither one
 * campaign's ceiling nor the brand's the moment a brand states a second offer —
 * see `aggregateOfferBudget`.
 *
 * AND THE LEG IS THE GRAIN A CAMPAIGN IS BOUGHT AT. A sales funnel is a chain of
 * steps and the thing a customer BUYS is one of its LEGS: the leg that takes a
 * lead sitting at one step and moves it to the next. A campaign has been
 * redefined as (brand, offer, acquisition channel, LEG), and one leg belongs to
 * SEVERAL funnels at once — so the funnel is becoming a way of READING legs
 * rather than the unit anything is keyed on. Migration 0039 puts the leg in the
 * key for exactly that reason, and this is the ADDITIVE half: the funnel STAYS
 * in the key, every existing read answers what it answers today, and a later
 * ship removes the funnel once every consumer has moved.
 *
 * THE LEG IDENTIFIER IS features-service's, AND IT IS OPAQUE. It mints the value
 * (`lib/funnel-legs.ts`, published on `GET /public/channels` as `legs[].legKey`)
 * and campaign-service carries the same one on the campaign row. billing stores
 * whatever the customer funds and never validates it, exactly as for the channel
 * slug and the offer id — and never PARSES it: the two steps a leg connects ride
 * BESIDE the identifier on that catalogue, so a consumer that wants them reads
 * them there. Splitting the string is how a second, drifting vocabulary starts.
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
 * DEFAULT product minimum per funded funnel, in cents/day — what a ceiling must
 * clear when the acquisition channel funding it states no floor of its own. The
 * floor that actually binds a write is `minDailyBudgetCentsFor(funnel, channel)`
 * (a channel whose economics differ, e.g. Google Ads, overrides this). A funnel at 0 is NOT funded
 * and is always accepted — that is how a customer pauses one, and a set where
 * EVERY funnel is 0 is a brand in pause, not an error. ("At least one funded
 * funnel" belongs to the checkout that spends money, not to storage: enforcing
 * it here would make it impossible to pause everything from settings.)
 *
 * The minimum governs what a customer may NEWLY STATE, not what one has already
 * been running — see `assertFundedChannelMeetsMinimum`.
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

/**
 * Every acquisition channel this service will price, and the daily floor that
 * channel states of its OWN — `null` when it states none, so the funnel's floor
 * above governs it.
 *
 * THE VIABLE FLOOR IS A PROPERTY OF THE FUNNEL **AND** THE CHANNEL, not of the
 * funnel alone. A cold-email funnel and a paid-ads funnel do not become viable
 * at the same daily number: one buys sending capacity, the other buys auction
 * placement. So Google Ads runs from $5/day on every funnel it sells, including
 * the visit-to-meeting funnel whose cold-email floor is $24/day — that is not
 * this funnel getting cheaper, it is a different channel with its own economics.
 * No other channel's floor moves.
 *
 * THIS IS NOT THE PRODUCT TAXONOMY, AND IT IS NOT A SECOND COPY OF IT. billing
 * still never asks whether a feature may be SOLD through a funnel — that stays
 * features-service's statement, and nothing here validates the pair. What each
 * entry states is billing's own business: the money a campaign on that channel
 * needs before it can run.
 *
 * A slug that is absent FAILS LOUDLY (`UnknownAcquisitionChannelError` → 400)
 * rather than quietly taking the funnel's floor. A channel whose economics
 * differ would otherwise be funded at a number nobody chose for it, which is
 * exactly the bug this table exists to make impossible; a 400 naming the slug is
 * a deploy away from fixed, a silently wrong floor is money already spent. The
 * cost is real and accepted: a channel features-service publishes before billing
 * prices it cannot be funded until an entry lands here.
 */
export const ACQUISITION_CHANNEL_MIN_DAILY_BUDGET_CENTS: Record<
  string,
  number | null
> = {
  // Paid reach — bought placement. Google Ads is the one channel that states a
  // floor of its own today ($5/day, every funnel it sells).
  "google-ads": 500,
  "bing-ads": null,
  "linkedin-ads": null,
  "meta-ads": null,
  "quora-ads": null,
  "reddit-ads": null,
  "tiktok-ads": null,
  "x-ads": null,
  "youtube-ads": null,
  "creator-sponsorships": null,
  "newsletter-sponsorships": null,
  "podcast-sponsorships": null,
  "paid-directory-listings": null,
  // Outbound, one to one.
  "sales-cold-email-outreach": null,
  "sales-crm-email-outreach": null,
  "feedback-request-cold-email-outreach": null,
  "cold-call-outreach": null,
  "cold-instagram-outreach": null,
  "cold-linkedin-outreach": null,
  "cold-reddit-outreach": null,
  "cold-sms-outreach": null,
  "cold-whatsapp-outreach": null,
  "cold-x-outreach": null,
  // Earned.
  "affiliate-programme": null,
  "organic-linkedin-publishing": null,
  "organic-reddit-publishing": null,
  "organic-x-publishing": null,
  "organic-youtube-publishing": null,
  "podcast-guesting": null,
  "pr-cold-email-outreach": null,
  "pr-expert-quote-opportunities": null,
  "pr-expert-quote-outreach": null,
  "press-placements": null,
  "seo-content": null,
};

/** An acquisition channel this service states no floor for. Surfaced as a 400. */
export class UnknownAcquisitionChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownAcquisitionChannelError";
  }
}

/** True when this service prices that acquisition channel. */
export function isKnownAcquisitionChannel(featureSlug: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    ACQUISITION_CHANNEL_MIN_DAILY_BUDGET_CENTS,
    featureSlug
  );
}

/**
 * The daily floor a funded ceiling on this (funnel, channel) pair must clear:
 * the channel's own floor when it states one, else the funnel's.
 *
 * Throws on a channel this service does not price, rather than resolving to the
 * funnel's floor — see the table above.
 */
export function minDailyBudgetCentsFor(
  funnelKey: BrandFunnelKey,
  featureSlug: string
): number {
  if (!isKnownAcquisitionChannel(featureSlug)) {
    throw new UnknownAcquisitionChannelError(
      `Unknown acquisition channel "${featureSlug}" — this service states no daily minimum for it, ` +
        `so it cannot say what funding it needs to run. Valid channels: ${Object.keys(ACQUISITION_CHANNEL_MIN_DAILY_BUDGET_CENTS).sort().join(", ")}.`
    );
  }
  return (
    ACQUISITION_CHANNEL_MIN_DAILY_BUDGET_CENTS[featureSlug] ??
    BRAND_FUNNEL_MIN_DAILY_BUDGET_CENTS[funnelKey]
  );
}

/**
 * The floor this channel states of its OWN, or null when it states none (so its
 * funnel's floor governs it). Throws on a channel this service does not price.
 */
export function statedChannelMinimum(featureSlug: string): number | null {
  if (!isKnownAcquisitionChannel(featureSlug)) {
    throw new UnknownAcquisitionChannelError(
      `Unknown acquisition channel "${featureSlug}" — this service states no daily minimum for it, ` +
        `so it cannot say what funding it needs to run. Valid channels: ${Object.keys(ACQUISITION_CHANNEL_MIN_DAILY_BUDGET_CENTS).sort().join(", ")}.`
    );
  }
  return ACQUISITION_CHANNEL_MIN_DAILY_BUDGET_CENTS[featureSlug];
}

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
 * A (funnel, channel, offer)-grain write against a triple that is funded for
 * SEVERAL legs. Surfaced as a 409, the same posture as the refusals above and
 * for the same reason one grain down: a campaign is bought for ONE leg, so
 * picking one of two legs would move the money onto the wrong campaign.
 */
export class OfferSplitAcrossLegsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferSplitAcrossLegsError";
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
  /**
   * The funnel LEG this ceiling funds, as features-service's canonical leg id
   * (migration 0039). OPTIONAL: a caller that speaks per (funnel, channel,
   * offer) only (every caller before 0039) omits it and the triple's existing
   * leg is used.
   */
  legKey?: unknown;
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
  /**
   * The leg the caller named, or `undefined` when it named none — resolved
   * under the write lock against what the (funnel, channel, offer) triple
   * already funds.
   *
   * `undefined` and `null` differ here for the same reason they do on `offerId`
   * one grain up: `undefined` is "the caller said nothing about legs", `null` is
   * a stored value meaning "this ceiling is not scoped to a leg".
   */
  legKey?: string;
  dailyBudgetCents: string;
}

/** A stored ceiling's offer after resolution: an offer UUID, or unscoped. */
export type ResolvedOfferId = string | null;

/** A stored ceiling's leg after resolution: a features-service leg id, or unscoped. */
export type ResolvedLegKey = string | null;

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
      // A channel this service prices no floor for is refused HERE, before any
      // lock is taken and whatever the amount. No silent fallback onto the
      // funnel's floor — see ACQUISITION_CHANNEL_MIN_DAILY_BUDGET_CENTS.
      if (!isKnownAcquisitionChannel(featureSlug)) {
        throw new UnknownAcquisitionChannelError(
          `${BRAND_FUNNEL_LABELS[funnelKey]}: unknown acquisition channel "${featureSlug}" — this service states no daily minimum for it, ` +
            `so it cannot say what funding it needs to run. Valid channels: ${Object.keys(ACQUISITION_CHANNEL_MIN_DAILY_BUDGET_CENTS).sort().join(", ")}.`
        );
      }
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

    // The LEG, when the caller named one. features-service mints the value and
    // owns the vocabulary, so this checks the SHAPE only — a non-empty string —
    // and never against a list, never by parsing it into the steps it connects.
    // A leg billing does not know is a leg billing stores.
    let legKey: string | undefined;
    if (entry.legKey !== undefined && entry.legKey !== null) {
      if (typeof entry.legKey !== "string" || !entry.legKey.trim()) {
        throw new InvalidFunnelSetError(
          `${BRAND_FUNNEL_LABELS[funnelKey]}: legKey must be a non-empty funnel leg id.`
        );
      }
      legKey = entry.legKey.trim();
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
        (p) =>
          p.featureSlug === featureSlug &&
          p.offerId === offerId &&
          p.legKey === legKey
      )
    ) {
      throw new InvalidFunnelSetError(
        featureSlug
          ? `Sales funnel "${funnelKey}" appears twice for channel "${featureSlug}"${offerId ? ` and offer "${offerId}"` : ""}${legKey ? ` and leg "${legKey}"` : ""} in the same set.`
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
    // And the same rule one grain further down: a set stating a
    // (funnel, channel, offer) triple both with and without a leg is asking for
    // two ceilings whose grains overlap, so it does not say which one the
    // leg-less figure is.
    if (
      sameFunnel.some(
        (p) =>
          p.featureSlug === featureSlug &&
          p.offerId === offerId &&
          (p.legKey === undefined) !== (legKey === undefined)
      )
    ) {
      throw new InvalidFunnelSetError(
        `Sales funnel "${funnelKey}" on acquisition channel "${featureSlug}"${offerId ? ` for offer "${offerId}"` : ""} is set both with and without a funnel leg in the same set.`
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

    // `offerId` and `legKey` are spread rather than assigned so an unstated one
    // leaves the property ABSENT, which is what distinguishes it from a stored
    // null.
    parsed.push({
      funnelKey,
      featureSlug,
      dailyBudgetCents,
      ...(offerId === undefined ? {} : { offerId }),
      ...(legKey === undefined ? {} : { legKey }),
    });
  }

  return parsed;
}

/**
 * WHICH CEILINGS ARE JUDGED TOGETHER against one floor.
 *
 * A channel that states a floor of its OWN is judged ALONE, on the sum of the
 * offers funding it: its economics are its own, so neither its siblings' money
 * nor their floor has anything to say about whether it can run. Google Ads at
 * $5/day on a funnel whose cold-email floor is $24 is the whole point.
 *
 * Every channel that states NO floor of its own is judged with its siblings that
 * also state none, against the FUNNEL's floor — exactly as before Google Ads
 * arrived. Splitting one funded funnel across two such channels ($12 + $12 on a
 * $24/day funnel) stays accepted: neither channel's floor moved, and that split
 * changes nothing about what the funnel spends per day.
 *
 * The two groups do not pool. A channel with its own floor cannot lift its
 * siblings over theirs, and their money cannot excuse it from its own — which is
 * what stops "add a dollar of Google Ads" from becoming a way to fund anything
 * below the floor it was refused at.
 */
export function minimumGroupOf(
  funnelKey: BrandFunnelKey,
  featureSlug: string
): string {
  const channelMinimum = statedChannelMinimum(featureSlug);
  // The empty slug is unrepresentable (parse rejects it), so it cannot collide
  // with a real channel's group.
  return channelMinimum === null ? `${funnelKey}\u0000` : `${funnelKey}\u0000${featureSlug}`;
}

/**
 * A funded group must clear its floor, and the floor binds the group's TOTAL —
 * the sum of every ceiling in it — never one ceiling in isolation. A customer
 * splitting a funded funnel across two channels that state no floor of their
 * own, or one channel across two offers, must not be refused because each part
 * is under a floor the whole clears.
 *
 * Zero is exempt — a group whose ceilings all sit at 0 is "not funding that
 * right now", which is an ordinary state, and a brand whose every ceiling is 0
 * is a brand in pause, not an error.
 *
 * GRANDFATHERING, UNCHANGED. The minimum polices what a customer may NEWLY
 * STATE, not what one has already been running. Ceilings predating the minimum
 * were carried over verbatim by the single-funnel attribution sweep —
 * deliberately, because they are the money the brand is actually spending — so
 * live brands sit below their floor today. Refusing every write of such a
 * ceiling leaves its owner only two moves: leave it exactly alone, or defund it
 * to zero. Raising it TOWARDS the floor would be refused, which is the wrong
 * direction to block.
 *
 * So a group whose STORED total is above zero and below its minimum may be
 * re-stated or RAISED to any higher value, including one still below the
 * minimum. It may not be LOWERED to another funded sub-minimum value: that is a
 * new statement below the floor, which is exactly what the minimum exists to
 * refuse. Zero is always accepted (defunding is never blocked).
 *
 * The grandfather is spent the moment the total reaches its minimum — that falls
 * out of the ordinary check below rather than needing its own branch, since a
 * stored value at or above the minimum never enters the grandfather clause. It
 * is derived from the stored ceiling and nothing else: no flag, no column, no
 * per-org override.
 *
 * `storedDailyBudgetCents` is this GROUP's own current total (null when it funds
 * none), read under the write lock. Each group is judged against its own, so one
 * grandfathered funnel in a set never licenses a sub-minimum value elsewhere.
 */
export function assertFundedChannelMeetsMinimum(
  funnelKey: BrandFunnelKey,
  featureSlug: string,
  dailyBudgetCents: string,
  storedDailyBudgetCents: string | null = null
): void {
  // The channel is resolved BEFORE the zero shortcut: a slug this service does
  // not price is refused whatever the amount, so an unknown channel can never be
  // stored and then re-stated at a floor nobody chose for it.
  const minimum = minDailyBudgetCentsFor(funnelKey, featureSlug);

  const value = new Decimal(dailyBudgetCents);
  if (value.isZero()) return;

  if (value.greaterThanOrEqualTo(minimum)) return;

  // The channel is named only when the floor is ITS OWN. Where the funnel's
  // floor governs, the funnel is what the customer is being told about — the
  // same sentence this service has always sent.
  const where =
    statedChannelMinimum(featureSlug) === null
      ? BRAND_FUNNEL_LABELS[funnelKey]
      : `${BRAND_FUNNEL_LABELS[funnelKey]} on ${featureSlug}`;
  const what = statedChannelMinimum(featureSlug) === null ? "funnel" : "channel";

  const stored =
    storedDailyBudgetCents === null ? null : new Decimal(storedDailyBudgetCents);
  const grandfathered =
    stored !== null && stored.greaterThan(0) && stored.lessThan(minimum);

  if (grandfathered) {
    if (value.greaterThanOrEqualTo(stored)) return;
    throw new FunnelBudgetBelowMinimumError(
      `${where} is funded at ${dollarsPerDay(stored.toString())}, below the ${dollarsPerDay(minimum)} this ${what} now needs to run. You can keep it at ${dollarsPerDay(stored.toString())}, raise it, or set it to 0 to stop funding it — you set ${dollarsPerDay(dailyBudgetCents)}.`
    );
  }

  throw new FunnelBudgetBelowMinimumError(
    `${where} needs at least ${dollarsPerDay(minimum)} to run — you set ${dollarsPerDay(dailyBudgetCents)}. Set it to 0 if you do not want to fund this ${what} right now.`
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

/** One (funnel, channel, offer) triple's figure: the SUM of every leg funding it. */
export interface OfferBudgetTotal {
  funnelKey: string;
  featureSlug: string;
  offerId: ResolvedOfferId;
  dailyBudgetCents: string;
  updatedAt: Date;
}

/**
 * Collapse per-LEG rows onto the per-OFFER figure migration 0037's consumers
 * ask for. Same rule as `aggregateChannelTotals` one level down, and the ONLY
 * place that sum is composed: a brand that has never funded a leg holds one row
 * per triple, so this is byte-identical to what shipped before 0039.
 */
export function aggregateOfferTotals(
  rows: BrandFunnelDailyBudget[]
): OfferBudgetTotal[] {
  const byTriple = new Map<string, OfferBudgetTotal>();
  for (const row of rows) {
    const key = `${row.funnelKey} ${row.featureSlug} ${row.offerId ?? ""}`;
    const current = byTriple.get(key);
    if (!current) {
      byTriple.set(key, {
        funnelKey: row.funnelKey,
        featureSlug: row.featureSlug,
        offerId: row.offerId,
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
    [...byTriple.values()].sort(
      (a, b) =>
        a.featureSlug.localeCompare(b.featureSlug) ||
        (a.offerId ?? "").localeCompare(b.offerId ?? "")
    ),
    (t) => t.funnelKey
  );
}

/**
 * One OFFER's daily ceiling: what the customer has funded that one proposition
 * at, across every funnel and channel it is sold through.
 *
 * The grain exists because an offer-scoped screen shows a fraction — that
 * offer's spend today over the ceiling it is paced against — and the only
 * denominator this service used to serve was the BRAND's. The two halves are
 * then about different things the moment a brand states a second proposition.
 * It reads correctly today only because every live brand names one offer.
 */
export interface OfferBudgetView {
  offerId: string;
  /** The SUM of the ceilings funding this offer. */
  dailyBudgetCents: string;
  /** The latest of those ceilings, so it moves whenever the offer's money does. */
  updatedAt: Date;
  /** This offer's per-funnel figures — the same sums, restricted to it. */
  funnels: FunnelBudgetTotal[];
  /** This offer's per-(funnel, channel) figures — the same sums, restricted to it. */
  channels: ChannelBudgetTotal[];
  /**
   * ADDITIVE: this offer's per-(funnel, channel, offer) figures — the grain a
   * campaign was bought at before legs existed, restricted to it.
   */
  offers: OfferBudgetTotal[];
  /** ADDITIVE: this offer's STORED ceilings, one per campaign (leg included). */
  legs: BrandFunnelDailyBudget[];
}

/** Every offer this brand names, in stable order. Unscoped ceilings name none. */
export function namedOffersOf(
  rows: Array<{ offerId: ResolvedOfferId }>
): string[] {
  return [
    ...new Set(
      rows
        .map((row) => row.offerId)
        .filter((offerId): offerId is string => offerId !== null)
    ),
  ];
}

/**
 * The stored ceilings that fund one offer.
 *
 * A ceiling that NAMES the offer always counts. An UNSCOPED ceiling
 * (`offer_id IS NULL`, every ceiling written before offers existed) counts only
 * when this offer is the brand's SOLE named one — then the brand's money has
 * exactly one campaign-owner and the offer's total is the brand's, which is what
 * keeps every live brand's screen on the number it shows today. With two named
 * offers there is no honest owner for an unscoped remainder, so it belongs to
 * neither: the same posture `resolveEntryOfferId` and `supersededUnscopedRows`
 * take one grain down, where an unscoped ceiling is read as an offer's money
 * only while it is the pair's only one.
 *
 * An offer that names nothing here has NO ceiling — which is a different answer
 * from a ceiling of zero, and neither is invented from the other.
 */
export function offerBudgetRows(
  rows: BrandFunnelDailyBudget[],
  offerId: string
): BrandFunnelDailyBudget[] {
  const named = namedOffersOf(rows);
  const owned = rows.filter((row) => row.offerId === offerId);
  if (owned.length === 0) return [];

  const soleNamedOffer = named.length === 1 && named[0] === offerId;
  if (!soleNamedOffer) return owned;
  return rows.filter((row) => row.offerId === offerId || row.offerId === null);
}

/**
 * One offer's ceiling and its breakdown, or null when the offer has none.
 *
 * The ONE place the per-offer sum is composed — a consumer that adds the stored
 * ceilings up itself is a consumer that will one day disagree with this service,
 * which is why every other grain is served here too.
 */
export function aggregateOfferBudget(
  rows: BrandFunnelDailyBudget[],
  offerId: string
): OfferBudgetView | null {
  const owned = offerBudgetRows(rows, offerId);
  if (owned.length === 0) return null;

  let updatedAt = owned[0].updatedAt;
  for (const row of owned) {
    if (row.updatedAt > updatedAt) updatedAt = row.updatedAt;
  }

  return {
    offerId,
    dailyBudgetCents: sumFunnelBudgets(owned),
    updatedAt,
    funnels: aggregateFunnelTotals(owned),
    channels: aggregateChannelTotals(owned),
    offers: aggregateOfferTotals(owned),
    legs: owned,
  };
}

/** Every leg this brand names, in stable order. Leg-less ceilings name none. */
export function namedLegsOf(rows: Array<{ legKey: ResolvedLegKey }>): string[] {
  return [
    ...new Set(
      rows
        .map((row) => row.legKey)
        .filter((legKey): legKey is string => legKey !== null)
    ),
  ];
}

/**
 * The stored ceilings that fund one LEG.
 *
 * Exactly the rule `offerBudgetRows` holds one grain up, and for the same
 * reason. A ceiling that NAMES the leg always counts. A LEG-LESS ceiling
 * (`leg_key IS NULL`, every ceiling written before legs existed) counts only
 * when this leg is the brand's SOLE named one — then the brand's money has
 * exactly one campaign-owner and the leg's total is the brand's, which keeps
 * every live brand's screen on the number it shows today. With two named legs
 * there is no honest owner for a leg-less remainder, so it belongs to neither.
 *
 * A leg that names nothing here has NO ceiling — a different answer from a
 * ceiling of zero, and neither is invented from the other.
 */
export function legBudgetRows(
  rows: BrandFunnelDailyBudget[],
  legKey: string
): BrandFunnelDailyBudget[] {
  const named = namedLegsOf(rows);
  const owned = rows.filter((row) => row.legKey === legKey);
  if (owned.length === 0) return [];

  const soleNamedLeg = named.length === 1 && named[0] === legKey;
  if (!soleNamedLeg) return owned;
  return rows.filter((row) => row.legKey === legKey || row.legKey === null);
}

/**
 * One LEG's ceiling and its breakdown, or null when the leg has none.
 *
 * The grain a CAMPAIGN is bought at: a campaign is (brand, offer, acquisition
 * channel, leg), so this is the money that paces one campaign, read on the same
 * key the campaign itself is keyed on. The ONE place the per-leg sum is
 * composed — every other grain is served beside it so no consumer adds anything
 * up.
 */
export interface LegBudgetView {
  legKey: string;
  /** The SUM of the ceilings funding this leg. */
  dailyBudgetCents: string;
  /** The latest of those ceilings, so it moves whenever the leg's money does. */
  updatedAt: Date;
  /** This leg's per-funnel figures — the same sums, restricted to it. */
  funnels: FunnelBudgetTotal[];
  /** This leg's per-(funnel, channel) figures, same restriction. */
  channels: ChannelBudgetTotal[];
  /** This leg's per-(funnel, channel, offer) figures, same restriction. */
  offers: OfferBudgetTotal[];
  /** This leg's STORED ceilings. */
  legs: BrandFunnelDailyBudget[];
}

export function aggregateLegBudget(
  rows: BrandFunnelDailyBudget[],
  legKey: string
): LegBudgetView | null {
  const owned = legBudgetRows(rows, legKey);
  if (owned.length === 0) return null;

  let updatedAt = owned[0].updatedAt;
  for (const row of owned) {
    if (row.updatedAt > updatedAt) updatedAt = row.updatedAt;
  }

  return {
    legKey,
    dailyBudgetCents: sumFunnelBudgets(owned),
    updatedAt,
    funnels: aggregateFunnelTotals(owned),
    channels: aggregateChannelTotals(owned),
    offers: aggregateOfferTotals(owned),
    legs: owned,
  };
}

/** One funnel's current total across its channels, "0" when it funds none. */
export function funnelTotalOf(
  rows: Array<{ funnelKey: string; dailyBudgetCents: string }>,
  funnelKey: string
): string {
  return sumFunnelBudgets(rows.filter((row) => row.funnelKey === funnelKey));
}

/**
 * One (funnel, channel) pair's current total across its offers, "0" when it
 * funds none. The grain the product minimum binds — see
 * `assertFundedChannelMeetsMinimum`.
 */
export function channelTotalOf(
  rows: Array<{
    funnelKey: string;
    featureSlug: string;
    dailyBudgetCents: string;
  }>,
  funnelKey: string,
  featureSlug: string
): string {
  return sumFunnelBudgets(
    rows.filter(
      (row) => row.funnelKey === funnelKey && row.featureSlug === featureSlug
    )
  );
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
 * Funnel order first, then channel slug, then offer, then leg (the unscoped
 * ceiling first at each grain, since it is the one that predates it), so a split
 * renders stably.
 */
function sortByFunnelOrder(
  rows: BrandFunnelDailyBudget[]
): BrandFunnelDailyBudget[] {
  return sortByFunnelOrderOf(
    [...rows].sort(
      (a, b) =>
        a.featureSlug.localeCompare(b.featureSlug) ||
        (a.offerId ?? "").localeCompare(b.offerId ?? "") ||
        (a.legKey ?? "").localeCompare(b.legKey ?? "")
    ),
    (row) => row.funnelKey
  );
}

export interface SetFunnelBudgetsResult {
  /**
   * Every STORED ceiling after the write, one per
   * (funnel, acquisition channel, offer, LEG) - i.e. one per campaign.
   */
  legs: BrandFunnelDailyBudget[];
  /**
   * Every STORED ceiling BEFORE this write, read under the same lock. The staff
   * notification needs the previous value of each individual ceiling to state
   * the RUNNING figure on the before side (see lib/brand-running-budget.ts) —
   * the brand-level scalar cannot express which campaign's money moved.
   */
  previousLegs: BrandFunnelDailyBudget[];
  /** The per-OFFER figures, each the sum of the legs funding that triple. */
  offers: OfferBudgetTotal[];
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
      // An offer-less entry (every caller before 0037 speaks per funnel and
      // channel only) is resolved against what the PAIR already funds, so a
      // legacy write can neither invent an offer nor silently move money onto
      // one of two campaigns.
      const offerId = resolveEntryOfferId(entry, featureSlug, existingFunnels);
      return {
        ...entry,
        featureSlug,
        offerId,
        // And a leg-less entry (every caller before 0039) is resolved against
        // what the TRIPLE already funds, one grain further down and by exactly
        // the same rule.
        legKey: resolveEntryLegKey(entry, featureSlug, offerId, existingFunnels),
      };
    });

    // A ceiling that NAMES an offer, written onto a pair whose only stored
    // ceiling is the pre-offer unscoped one, ADOPTS that ceiling rather than
    // sitting beside it - see `supersededUnscopedRows`. A ceiling that names a
    // LEG does the same to the pre-leg one, one grain down.
    const superseded = [
      ...supersededUnscopedRows(existingFunnels, resolved),
      ...supersededLegLessRows(existingFunnels, resolved),
    ];

    // The minimum binds a GROUP TOTAL, and which ceilings share a group is
    // `minimumGroupOf`: a channel that states its own floor is judged alone, and
    // every channel that states none is judged with its funnel's siblings, as
    // before Google Ads arrived. Each touched group is judged on what it will
    // sum to after this write, against what it sums to now (its grandfather).
    const projected = projectFunnelRows(
      existingFunnels,
      resolved,
      mode,
      superseded
    );
    const touchedGroups = new Map(
      resolved.map((e) => [
        minimumGroupOf(e.funnelKey, e.featureSlug),
        { funnelKey: e.funnelKey, featureSlug: e.featureSlug },
      ])
    );
    for (const [group, { funnelKey, featureSlug }] of touchedGroups) {
      const inGroup = (row: { funnelKey: string; featureSlug: string }) =>
        row.funnelKey === funnelKey &&
        minimumGroupOf(funnelKey, row.featureSlug) === group;
      const storedRows = existingFunnels.filter(inGroup);
      assertFundedChannelMeetsMinimum(
        funnelKey,
        featureSlug,
        sumFunnelBudgets(projected.filter(inGroup)),
        storedRows.length > 0 ? sumFunnelBudgets(storedRows) : null
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
            offerMatches(row.offerId),
            legMatches(row.legKey)
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
          legKey: entry.legKey,
          dailyBudgetCents: entry.dailyBudgetCents,
          updatedAt: changedAt,
        })
        // Inference resolves to the NULLS NOT DISTINCT unique constraint of
        // migration 0039, so an unscoped ceiling (offer_id / leg_key IS NULL)
        // upserts in place exactly as it did when the four columns were the
        // primary key.
        .onConflictDoUpdate({
          target: [
            brandFunnelDailyBudgets.orgId,
            brandFunnelDailyBudgets.brandId,
            brandFunnelDailyBudgets.funnelKey,
            brandFunnelDailyBudgets.featureSlug,
            brandFunnelDailyBudgets.offerId,
            brandFunnelDailyBudgets.legKey,
          ],
          set: {
            dailyBudgetCents: entry.dailyBudgetCents,
            updatedAt: changedAt,
          },
        });
    }

    const legs = sortByFunnelOrder(
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
    const offers = aggregateOfferTotals(legs);
    const channels = aggregateChannelTotals(legs);
    const funnels = aggregateFunnelTotals(legs);

    const brandDailyBudgetCents = sumFunnelBudgets(legs);

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
      legs,
      offers,
      previousLegs: existingFunnels,
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
 * Which LEG does this entry fund?
 *
 * A campaign is (brand, offer, acquisition channel, LEG), so this is the grain
 * the ceiling and the campaign are keyed on together. The rule is
 * `resolveEntryOfferId`'s, one grain down.
 *
 * A caller that named one is taken at its word: features-service owns the leg
 * vocabulary and mints the identifier, so billing no more asks whether that leg
 * exists than it asks whether an offer does or whether a feature may be sold
 * through a funnel. The value is stored opaque and never parsed.
 *
 * A caller that named none means "this (funnel, channel, offer) triple", the
 * finest grain that existed before 0039. It resolves to:
 *   - the triple's single leg, when it funds exactly one - and for every ceiling
 *     written before 0039 that is the LEG-LESS one (`null`), so brand Settings,
 *     the signup checkout and the gateway keep behaving exactly as they do now;
 *   - `null` (leg-less), when the triple funds nothing yet. There is
 *     deliberately no default leg to fall back to, the way there is a default
 *     channel: a funnel has several legs and a leg belongs to several funnels,
 *     so nothing here can pick one without attaching money to a campaign nobody
 *     named;
 *   - a refusal, when the triple is SPLIT across legs - the same posture the
 *     offer resolution takes one level up, because picking one of two legs moves
 *     real money onto the wrong campaign.
 */
function resolveEntryLegKey(
  entry: ParsedFunnelBudget,
  featureSlug: string,
  offerId: ResolvedOfferId,
  existing: BrandFunnelDailyBudget[]
): ResolvedLegKey {
  if (entry.legKey !== undefined) return entry.legKey;

  const legs = [
    ...new Set(
      existing
        .filter(
          (row) =>
            row.funnelKey === entry.funnelKey &&
            row.featureSlug === featureSlug &&
            row.offerId === offerId
        )
        .map((row) => row.legKey)
    ),
  ];
  if (legs.length === 0) return null;
  if (legs.length === 1) return legs[0];

  throw new OfferSplitAcrossLegsError(
    `${BRAND_FUNNEL_LABELS[entry.funnelKey]} on acquisition channel "${featureSlug}"${offerId ? ` for offer "${offerId}"` : ""} is funded for ${legs.length} funnel legs ` +
      `(${legs.map((key) => key ?? "no leg").join(", ")}). ` +
      `Name the leg you are funding - setting the offer as a whole would have to guess which campaign the money is for.`
  );
}

/**
 * The stored LEG-LESS ceilings this write ADOPTS — the mirror of
 * `resolveEntryLegKey`, and THE STATED PRECEDENCE between a leg-keyed ceiling
 * and a leg-less one describing the same money: THE LEG-KEYED CEILING REPLACES
 * IT. They are never summed and never both stored.
 *
 * `resolveEntryLegKey` already reads a leg-less ceiling as the money of the
 * triple's only leg, so a caller naming no leg updates it in place rather than
 * opening a second row. The mirror has to hold too: a ceiling written before
 * 0039 is the whole of what that (funnel, channel, offer) triple is funded at,
 * and that triple funds one campaign, so when a leg-aware caller names the leg
 * that campaign is bought for it is RE-STATING that same ceiling, not adding a
 * second one beside it. Without this the triple holds both and every figure
 * above it (a SUM) counts the customer's money twice — exactly the incoherence
 * migration 0038 had to repair one grain up.
 *
 * ONLY when the leg-less row is the triple's SOLE ceiling. A triple already
 * split across named legs has no unambiguous owner for a leg-less remainder, and
 * guessing one would move real money onto the wrong campaign — the same reason
 * `resolveEntryLegKey` refuses there rather than picking.
 *
 * The leg-LESS path is untouched: an entry that names no leg resolves to the
 * leg-less row and updates it, so no caller predating 0039 changes behaviour.
 */
function supersededLegLessRows(
  existing: BrandFunnelDailyBudget[],
  resolved: Array<{
    funnelKey: BrandFunnelKey;
    featureSlug: string;
    offerId: ResolvedOfferId;
    legKey: ResolvedLegKey;
  }>
): BrandFunnelDailyBudget[] {
  return existing.filter((row) => {
    if (row.legKey !== null) return false;

    const triple = existing.filter(
      (other) =>
        other.funnelKey === row.funnelKey &&
        other.featureSlug === row.featureSlug &&
        other.offerId === row.offerId
    );
    if (triple.length !== 1) return false;

    return resolved.some(
      (entry) =>
        entry.legKey !== null &&
        entry.funnelKey === row.funnelKey &&
        entry.featureSlug === row.featureSlug &&
        entry.offerId === row.offerId
    );
  });
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

/** A stored ceiling's identity: one (funnel, channel, offer, leg) = one campaign. */
function rowIdentity(row: {
  funnelKey: string;
  featureSlug: string;
  offerId: ResolvedOfferId;
  legKey: ResolvedLegKey;
}): string {
  return `${row.funnelKey}\u0000${row.featureSlug}\u0000${row.offerId ?? ""}\u0000${row.legKey ?? ""}`;
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
 * Match one ceiling's LEG in a WHERE clause. Same `IS NULL` requirement as
 * `offerMatches` one grain up — `= NULL` matches nothing, which would silently
 * leave the row a replace-mode write is supposed to delete.
 */
function legMatches(legKey: ResolvedLegKey) {
  return legKey === null
    ? isNull(brandFunnelDailyBudgets.legKey)
    : eq(brandFunnelDailyBudgets.legKey, legKey);
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
    legKey: ResolvedLegKey;
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
