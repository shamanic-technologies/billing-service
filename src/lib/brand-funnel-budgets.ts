/**
 * Per-funnel daily spending ceilings for a brand.
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
 * NO BACKFILL. A brand that has never set per-funnel ceilings keeps its
 * brand_daily_budgets row as the authoritative value and behaves exactly as it
 * does today. Splitting an existing budget across funnels would invent numbers
 * the customer never stated.
 *
 * The two states are mutually exclusive by construction: the first per-funnel
 * write DELETES the superseded brand-level row (in the same transaction), and
 * PATCH /v1/brands/:brandId/daily-budget refuses (409) to write a brand that is
 * funnel-funded. So there is never a stale scalar sitting beside the ceilings
 * that could disagree with their sum.
 *
 * Fail-loud: any DB error propagates.
 */

import { and, eq, inArray } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import {
  brandDailyBudgets,
  brandDailyBudgetChanges,
  brandFunnelDailyBudgets,
  type BrandFunnelDailyBudget,
} from "../db/schema.js";
import { addCents, parseNonNegativeCents } from "./cents.js";

/** brand-service's sales-funnel keys, verbatim. */
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

export interface FunnelBudgetInput {
  funnelKey: string;
  dailyBudgetCents: unknown;
}

export interface ParsedFunnelBudget {
  funnelKey: BrandFunnelKey;
  dailyBudgetCents: string;
}

/**
 * Validate one whole set BEFORE anything is written. Throws on the first
 * problem, so a rejected set leaves nothing half-applied (the caller has not
 * opened a transaction yet).
 */
export function parseFunnelBudgetSet(
  entries: FunnelBudgetInput[]
): ParsedFunnelBudget[] {
  const seen = new Set<string>();
  const parsed: ParsedFunnelBudget[] = [];

  for (const entry of entries) {
    if (typeof entry?.funnelKey !== "string" || !isBrandFunnelKey(entry.funnelKey)) {
      throw new InvalidFunnelSetError(
        `Unknown sales funnel "${String(entry?.funnelKey)}". Valid funnels: ${BRAND_FUNNEL_KEYS.join(", ")}.`
      );
    }
    if (seen.has(entry.funnelKey)) {
      throw new InvalidFunnelSetError(
        `Sales funnel "${entry.funnelKey}" appears twice in the same set.`
      );
    }
    seen.add(entry.funnelKey);

    let dailyBudgetCents: string;
    try {
      dailyBudgetCents = parseNonNegativeCents(entry.dailyBudgetCents);
    } catch (err) {
      throw new InvalidFunnelSetError(
        `${BRAND_FUNNEL_LABELS[entry.funnelKey]}: ${
          err instanceof Error ? err.message : "invalid dailyBudgetCents"
        }`
      );
    }

    assertFundedFunnelMeetsMinimum(entry.funnelKey, dailyBudgetCents);
    parsed.push({ funnelKey: entry.funnelKey, dailyBudgetCents });
  }

  return parsed;
}

/**
 * A funnel that IS funded has a product minimum. Zero is exempt — it means "not
 * funding that funnel right now", which is an ordinary state.
 */
export function assertFundedFunnelMeetsMinimum(
  funnelKey: BrandFunnelKey,
  dailyBudgetCents: string
): void {
  const value = new Decimal(dailyBudgetCents);
  if (value.isZero()) return;

  const minimum = BRAND_FUNNEL_MIN_DAILY_BUDGET_CENTS[funnelKey];
  if (value.greaterThanOrEqualTo(minimum)) return;

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

/** Read one org's per-funnel ceilings for a brand. Empty when never set. */
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
function sortByFunnelOrder(
  rows: BrandFunnelDailyBudget[]
): BrandFunnelDailyBudget[] {
  const order = new Map<string, number>(
    BRAND_FUNNEL_KEYS.map((key, i) => [key as string, i])
  );
  return [...rows].sort(
    (a, b) =>
      (order.get(a.funnelKey) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b.funnelKey) ?? Number.MAX_SAFE_INTEGER)
  );
}

export interface SetFunnelBudgetsResult {
  funnels: BrandFunnelDailyBudget[];
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
 * Everything is validated by the CALLER (parseFunnelBudgetSet) before the
 * transaction opens, so a rejected set leaves nothing half-applied. Inside the
 * transaction we also:
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

    const previousBrandDailyBudgetCents =
      existingFunnels.length > 0
        ? sumFunnelBudgets(existingFunnels)
        : existingBrandRow
          ? existingBrandRow.dailyBudgetCents
          : null;

    if (mode === "replace") {
      const keep = entries.map((e) => e.funnelKey as string);
      const toDelete = existingFunnels
        .map((row) => row.funnelKey)
        .filter((key) => !keep.includes(key));
      if (toDelete.length > 0) {
        await tx
          .delete(brandFunnelDailyBudgets)
          .where(
            and(
              eq(brandFunnelDailyBudgets.orgId, orgId),
              eq(brandFunnelDailyBudgets.brandId, brandId),
              inArray(brandFunnelDailyBudgets.funnelKey, toDelete)
            )
          );
      }
    }

    for (const entry of entries) {
      await tx
        .insert(brandFunnelDailyBudgets)
        .values({
          orgId,
          brandId,
          funnelKey: entry.funnelKey,
          dailyBudgetCents: entry.dailyBudgetCents,
          updatedAt: changedAt,
        })
        .onConflictDoUpdate({
          target: [
            brandFunnelDailyBudgets.orgId,
            brandFunnelDailyBudgets.brandId,
            brandFunnelDailyBudgets.funnelKey,
          ],
          set: {
            dailyBudgetCents: entry.dailyBudgetCents,
            updatedAt: changedAt,
          },
        });
    }

    const funnels = sortByFunnelOrder(
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

    const brandDailyBudgetCents = sumFunnelBudgets(funnels);

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

    return { funnels, previousBrandDailyBudgetCents, brandDailyBudgetCents };
  });
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
