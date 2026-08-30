/**
 * Attributing an EXISTING brand-level ceiling to the one funnel it can only
 * belong to.
 *
 * Per-funnel ceilings (migration 0035) shipped with NO BACKFILL, and that is
 * still the rule: splitting one brand-level budget across several funnels would
 * invent a split the customer never stated. It is the right rule for a brand
 * that sells through several funnels.
 *
 * It says nothing about a brand that sells through exactly ONE. There the whole
 * ceiling belongs to that funnel by construction — there is no split to invent,
 * only an attribution to record. Leaving it unrecorded is what makes brand
 * Settings render "$0/day" on the funnel of a brand that is being charged
 * against a real ceiling: one entity, two figures that cannot both be true.
 *
 * So this decides, per brand, whether the attribution is UNAMBIGUOUS. It is a
 * pure function of two facts — the brand-level ceiling billing already stores,
 * and the funnels brand-service says the brand actively sells through — and it
 * refuses everything else. Nothing here changes what an org is charged: the
 * brand-level read answers the SUM of the ceilings, and a single ceiling equal
 * to the scalar it replaces sums to the same number.
 *
 * Fail loud on vocabulary drift: a funnel spelling this service cannot name
 * THROWS rather than being skipped, because a silent skip would read exactly
 * like "this brand declared nothing" and would leave the incoherence in place
 * with no signal.
 */

import { and, eq, sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import {
  brandDailyBudgets,
  brandFunnelDailyBudgets,
} from "../db/schema.js";
import {
  ACCEPTED_FUNNEL_KEYS,
  DEFAULT_ACQUISITION_CHANNEL_FEATURE_SLUG,
  toStoredFunnelKey,
  type BrandFunnelKey,
} from "./brand-funnel-budgets.js";

/** A funnel spelling billing cannot name. Aborts the sweep. */
export class UnknownDeclaredFunnelError extends Error {
  constructor(funnelKey: string, brandId: string) {
    super(
      `brand ${brandId} declares sales funnel "${funnelKey}", which billing cannot name. ` +
        `Known: ${ACCEPTED_FUNNEL_KEYS.join(", ")}.`
    );
    this.name = "UnknownDeclaredFunnelError";
  }
}

/**
 * Collapse any spelling brand-service may answer with onto the stored key.
 *
 * One vocabulary, resolved in ONE place (`toStoredFunnelKey`): this sweep and
 * the write routes must agree on which spellings name the same funnel, or the
 * two could disagree about whether a brand is already funded on it.
 *
 * Throws on anything else, rather than skipping — see the fail-loud note above.
 */
export function toBillingFunnelKey(
  funnelKey: string,
  brandId: string
): BrandFunnelKey {
  const resolved = toStoredFunnelKey(funnelKey);
  if (resolved) return resolved;
  throw new UnknownDeclaredFunnelError(funnelKey, brandId);
}

export type AttributionDecision =
  | { attribute: true; funnelKey: BrandFunnelKey }
  | { attribute: false; reason: string };

export interface AttributionInput {
  brandId: string;
  /** The brand-level ceiling billing stores today, canonical cents string. */
  dailyBudgetCents: string;
  /**
   * The funnel keys brand-service says this org actively sells this brand
   * through, in whatever spelling it answers with.
   */
  declaredFunnelKeys: string[];
}

/**
 * Is this brand's funding unambiguous — one funded ceiling, one funnel?
 *
 * Every "no" is a brand left EXACTLY as it is, which is the correct outcome for
 * an ambiguous case: an unfunded brand has no ceiling to attribute, a brand
 * declaring nothing has nowhere to attribute it, and a brand selling through
 * several funnels is the case the no-backfill rule exists for.
 */
export function decideAttribution(input: AttributionInput): AttributionDecision {
  const budget = new Decimal(input.dailyBudgetCents);
  if (!budget.greaterThan(0)) {
    return {
      attribute: false,
      reason: "brand-level ceiling is not funded (0) — nothing to attribute",
    };
  }

  const distinct = new Set<BrandFunnelKey>(
    input.declaredFunnelKeys.map((key) => toBillingFunnelKey(key, input.brandId))
  );

  if (distinct.size === 0) {
    return {
      attribute: false,
      reason: "brand declares no active sales funnel — nowhere to attribute it",
    };
  }
  if (distinct.size > 1) {
    return {
      attribute: false,
      reason: `brand sells through ${distinct.size} funnels (${[...distinct].join(", ")}) — the split is the customer's to state`,
    };
  }

  return { attribute: true, funnelKey: [...distinct][0] };
}

export type AttributionOutcome =
  /** The ceiling now sits on `funnelKey`; the brand-level scalar was dropped. */
  | { applied: true; dailyBudgetCents: string; funnelKey: BrandFunnelKey }
  /** Someone else got there first — already funnel-funded, or no scalar left. */
  | { applied: false; reason: string };

/**
 * Move one org+brand's brand-level ceiling onto a single funnel, atomically.
 *
 * This is an ATTRIBUTION, not a budget change, and every line here exists to
 * keep it one:
 *
 *   - the funnel ceiling is the scalar VERBATIM, so the brand-level read (which
 *     answers the SUM of the ceilings once any exist) returns the identical
 *     figure — no org's charge moves by a cent;
 *   - `updated_at` is COPIED from the row being replaced rather than stamped
 *     now, so even the timestamp the brand-level read serves is unchanged. It
 *     doubles as the marker of what this sweep touched: a real customer write
 *     stamps its own time;
 *   - NO `brand_daily_budget_changes` row is written. That table is the timeline
 *     of changes to the brand-level number, and this changes nothing about it.
 *     Appending here would show staff a change that never happened;
 *   - the superseded `brand_daily_budgets` row is DELETED in the same
 *     transaction, because the two states are mutually exclusive by design — a
 *     stale scalar left beside the ceilings is the incoherence this repo
 *     already refuses at the write routes.
 *
 * The product MINIMUM per funded funnel is deliberately NOT enforced. Those
 * minimums police what a customer may newly STATE; this records a ceiling they
 * are already being charged against, and several of the live ones sit below
 * their funnel's minimum. Refusing them would leave exactly the incoherence
 * this removes.
 *
 * Idempotent and concurrency-safe: an org+brand that already carries any funnel
 * ceiling is left alone (a human may have set it since the dry run), and the
 * scalar is row-locked for the duration.
 *
 * Reverse of one row, should it ever be needed — the scalar is fully recoverable
 * from the ceiling it became:
 *   INSERT INTO brand_daily_budgets (org_id, brand_id, daily_budget_cents, updated_at)
 *   SELECT org_id, brand_id, daily_budget_cents, updated_at
 *     FROM brand_funnel_daily_budgets WHERE org_id = $1 AND brand_id = $2;
 *   DELETE FROM brand_funnel_daily_budgets WHERE org_id = $1 AND brand_id = $2;
 *
 * Fail-loud: any DB error propagates.
 */
export async function attributeBrandBudgetToSingleFunnel(
  orgId: string,
  brandId: string,
  funnelKey: BrandFunnelKey
): Promise<AttributionOutcome> {
  return db.transaction(async (tx) => {
    const existingFunnels = await tx
      .select({ funnelKey: brandFunnelDailyBudgets.funnelKey })
      .from(brandFunnelDailyBudgets)
      .where(
        and(
          eq(brandFunnelDailyBudgets.orgId, orgId),
          eq(brandFunnelDailyBudgets.brandId, brandId)
        )
      )
      .limit(1);
    if (existingFunnels.length > 0) {
      return {
        applied: false,
        reason: "already funnel-funded — left exactly as it is",
      };
    }

    const [scalar] = await tx
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
    if (!scalar) {
      return { applied: false, reason: "no brand-level ceiling to attribute" };
    }

    // INSERT ... SELECT, so the amount and the timestamp are carried by
    // Postgres and never round-trip through JS. A `timestamptz` holds
    // MICROseconds and a JS Date holds milliseconds, so re-inserting a value
    // read into a Date silently truncates it (`…:32.764549+00` came back as
    // `…:32.764+00` on a live row). Nothing about money depended on those
    // microseconds, but "the row is copied verbatim" has to be true as written
    // — the copied timestamp is also the marker of what this sweep touched.
    // The ceiling lands on the platform's default acquisition channel: a
    // brand-level scalar predates channels entirely, so there is no second
    // channel it could belong to (a brand running one is exactly why this sweep
    // exists), and migration 0036 already recorded the fleet's one exception.
    // It lands UNSCOPED by offer (offer_id stays NULL), for the same reason:
    // brand-service owns the offer entity, a brand-level scalar predates offers
    // entirely, and inventing an id would attach the money to a campaign nobody
    // named. Same again for the funnel LEG (leg_key stays NULL): a funnel has
    // several legs and a leg belongs to several funnels, so nothing here can
    // derive the one this money is for.
    await tx.execute(sql`
      INSERT INTO brand_funnel_daily_budgets (org_id, brand_id, funnel_key, feature_slug, daily_budget_cents, updated_at)
      SELECT org_id, brand_id, ${funnelKey}, ${DEFAULT_ACQUISITION_CHANNEL_FEATURE_SLUG}, daily_budget_cents, updated_at
        FROM brand_daily_budgets
       WHERE org_id = ${orgId} AND brand_id = ${brandId}
    `);

    await tx
      .delete(brandDailyBudgets)
      .where(
        and(
          eq(brandDailyBudgets.orgId, orgId),
          eq(brandDailyBudgets.brandId, brandId)
        )
      );

    return {
      applied: true,
      dailyBudgetCents: scalar.dailyBudgetCents,
      funnelKey,
    };
  });
}
