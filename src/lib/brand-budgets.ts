/**
 * Org-scoped per-brand daily-budget store.
 *
 * ONE mutable scalar per (org_id, brand_id), upserted in place. This is an
 * allocation / pacing ceiling, NOT the org credit balance/affordability — see
 * the table comment in db/schema.ts. billing-service only stores + serves this
 * value; consumers read it with org identity and enforce the cap.
 *
 * Fail-loud: any DB error propagates (no swallow).
 */

import { and, asc, eq, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  brandDailyBudgets,
  brandDailyBudgetChanges,
  campaignDailyBudgets,
  type BrandDailyBudget,
  type BrandDailyBudgetChange,
} from "../db/schema.js";
import {
  BrandBudgetManagedByCampaignsError,
  sumCeilings,
} from "./campaign-budgets.js";
import {
  enumerateUtcDays,
  formatUtcDay,
  utcDayEndExclusive,
} from "./utc-day.js";

export interface UpsertBrandDailyBudgetResult {
  row: BrandDailyBudget;
  /**
   * The value stored for this org+brand BEFORE this write, read inside the same
   * transaction (row-locked) so a concurrent write cannot make it wrong. null
   * when this org+brand had no budget at all (a first-ever set).
   */
  previousDailyBudgetCents: string | null;
}

/**
 * Set / update a brand's daily budget for one org. `dailyBudgetCents` is a
 * canonical fixed-scale cents string.
 *
 * The current-value row (brand_daily_budgets) is upserted in place AND an
 * append-only history row (brand_daily_budget_changes) is inserted, both in ONE
 * transaction — so a budget change is never stored without its dated history
 * entry (the health-board timeline can never diverge from the current value).
 *
 * The pre-write value is SELECTed FOR UPDATE in that same transaction and
 * returned, so the staff notification's "from" side can never be a stale read
 * of a value another request has since changed. (A first-ever set has no row to
 * lock, so two concurrent first-ever writes for the same org+brand would both
 * report "unset"; the upsert still resolves the stored value correctly, and at
 * ~one write every four days fleet-wide that race is not worth a table lock.)
 */
export async function upsertBrandDailyBudget(
  orgId: string,
  brandId: string,
  dailyBudgetCents: string
): Promise<UpsertBrandDailyBudgetResult> {
  return db.transaction(async (tx) => {
    const changedAt = new Date();

    // A brand funded per campaign derives this value from its campaign
    // ceilings (lib/campaign-budgets.ts). Accepting a brand-level write would
    // leave two numbers claiming to be the same thing, so refuse it — the caller
    // surfaces a 409 pointing at the per-campaign routes.
    const ceilingRows = await tx
      .select({ featureSlug: campaignDailyBudgets.featureSlug })
      .from(campaignDailyBudgets)
      .where(
        and(
          eq(campaignDailyBudgets.orgId, orgId),
          eq(campaignDailyBudgets.brandId, brandId)
        )
      )
      .limit(1);
    if (ceilingRows.length > 0) {
      throw new BrandBudgetManagedByCampaignsError(
        "This brand's daily budget is set per campaign. Change the campaign ceilings instead — the brand's daily budget is their total."
      );
    }

    const [existing] = await tx
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

    const [row] = await tx
      .insert(brandDailyBudgets)
      .values({
        brandId,
        orgId,
        dailyBudgetCents,
        updatedAt: changedAt,
      })
      .onConflictDoUpdate({
        target: [brandDailyBudgets.orgId, brandDailyBudgets.brandId],
        set: {
          dailyBudgetCents,
          updatedAt: changedAt,
        },
      })
      .returning();

    await tx.insert(brandDailyBudgetChanges).values({
      orgId,
      brandId,
      dailyBudgetCents,
      changedAt,
    });

    return {
      row,
      previousDailyBudgetCents: existing ? existing.dailyBudgetCents : null,
    };
  });
}

/**
 * Read one org's ordered daily-budget change history for a brand, oldest first
 * (chronological timeline). Empty array when no budget has ever been set for
 * that org+brand.
 */
export async function getBrandDailyBudgetHistory(
  orgId: string,
  brandId: string
): Promise<BrandDailyBudgetChange[]> {
  return db
    .select()
    .from(brandDailyBudgetChanges)
    .where(
      and(
        eq(brandDailyBudgetChanges.orgId, orgId),
        eq(brandDailyBudgetChanges.brandId, brandId)
      )
    )
    .orderBy(
      asc(brandDailyBudgetChanges.changedAt),
      asc(brandDailyBudgetChanges.id)
    );
}

/**
 * Read one org's current daily budget for a brand, or null if none set.
 *
 * Once the brand carries campaign ceilings, this answers their SUM — the one
 * number the launch gate, the runway warnings, the credit alerts, the Overview
 * tile and campaign-service all read. No consumer re-composes that sum itself.
 *
 * A brand that has never set a campaign ceiling reads its own brand-level row
 * (no backfill). The two states are mutually exclusive: the first ceiling write
 * drops the brand-level row, and a brand-level write against a ceiling-funded
 * brand is refused.
 */
export async function getBrandDailyBudget(
  orgId: string,
  brandId: string
): Promise<BrandDailyBudget | null> {
  const ceilingRows = await db
    .select()
    .from(campaignDailyBudgets)
    .where(
      and(
        eq(campaignDailyBudgets.orgId, orgId),
        eq(campaignDailyBudgets.brandId, brandId)
      )
    );
  if (ceilingRows.length > 0) {
    const updatedAt = ceilingRows.reduce(
      (latest, row) => (row.updatedAt > latest ? row.updatedAt : latest),
      ceilingRows[0].updatedAt
    );
    return {
      brandId,
      orgId,
      dailyBudgetCents: sumCeilings(ceilingRows),
      updatedAt,
    };
  }

  const [row] = await db
    .select()
    .from(brandDailyBudgets)
    .where(
      and(
        eq(brandDailyBudgets.orgId, orgId),
        eq(brandDailyBudgets.brandId, brandId)
      )
    )
    .limit(1);
  return row ?? null;
}

/** What was in force for one brand on one past UTC day. */
export interface BrandDailyBudgetDay {
  /** The UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  /**
   * `recorded` — a change row governs this day, so `dailyBudgetCents` is the
   * amount that was in force. `not_recorded` — the day precedes the first
   * change this org+brand ever recorded, so billing does NOT know and says so.
   *
   * These are the two states the consumer must tell apart: a RECORDED `"0"` is
   * a brand the customer deliberately defunded, and it is not the same fact as
   * a day billing never observed.
   */
  state: "recorded" | "not_recorded";
  /** The amount in force at the END of that UTC day. null iff `not_recorded`. */
  dailyBudgetCents: string | null;
  /**
   * When that amount was set (ISO 8601). Falls INSIDE the day when the customer
   * changed it that day, and before it otherwise. null iff `not_recorded`.
   */
  inForceSince: string | null;
}

export interface BrandDailyBudgetByDay {
  /**
   * The first daily-budget change ever recorded for this org+brand (ISO 8601),
   * or null when none exists. Every day before it is `not_recorded` — the
   * change log is forward-only (migration 0027), so a budget set before it and
   * never touched since leaves no trace of WHEN it was set.
   */
  recordBeginsAt: string | null;
  days: BrandDailyBudgetDay[];
}

/**
 * Replay this org's daily-budget change log to answer what amount was in force
 * for a brand on each UTC day of a range, oldest day first.
 *
 * GRAIN: the BRAND total, which is the finest grain billing genuinely records
 * over time. `brand_daily_budget_changes` carries the brand-level figure on
 * EVERY write, per-campaign writes included (see setCampaignDailyBudget), so
 * the replay is complete for the brand. The campaign ceilings are upserted in
 * place with NO change log of their own, so
 * a past-day answer at that grain would be invented — we do not offer one.
 *
 * The amount in force for a day is the LAST change strictly before the next
 * day's 00:00:00Z, i.e. the value the day finished on. A day that precedes the
 * first recorded change is `not_recorded` with a null amount — never 0, and
 * never the current value back-dated.
 *
 * Fail-loud: any DB error propagates.
 */
export async function getBrandDailyBudgetByDay(
  orgId: string,
  brandId: string,
  fromDay: Date,
  toDay: Date
): Promise<BrandDailyBudgetByDay> {
  const scope = and(
    eq(brandDailyBudgetChanges.orgId, orgId),
    eq(brandDailyBudgetChanges.brandId, brandId)
  );

  // The record's own beginning, asked separately: a range entirely before the
  // first change returns no rows, and "no rows" alone cannot distinguish
  // "nothing recorded yet" from "nothing recorded in this window".
  const [earliest] = await db
    .select({ changedAt: brandDailyBudgetChanges.changedAt })
    .from(brandDailyBudgetChanges)
    .where(scope)
    .orderBy(
      asc(brandDailyBudgetChanges.changedAt),
      asc(brandDailyBudgetChanges.id)
    )
    .limit(1);

  const rangeEnd = utcDayEndExclusive(toDay);
  const changes = await db
    .select({
      dailyBudgetCents: brandDailyBudgetChanges.dailyBudgetCents,
      changedAt: brandDailyBudgetChanges.changedAt,
    })
    .from(brandDailyBudgetChanges)
    .where(and(scope, lt(brandDailyBudgetChanges.changedAt, rangeEnd)))
    .orderBy(
      asc(brandDailyBudgetChanges.changedAt),
      asc(brandDailyBudgetChanges.id)
    );

  // One forward walk over the changes, one cursor over the days: each day takes
  // the last change that landed before its end.
  let cursor = 0;
  let inForce: { dailyBudgetCents: string; changedAt: Date } | null = null;
  const days = enumerateUtcDays(fromDay, toDay).map((dayStart) => {
    const dayEnd = utcDayEndExclusive(dayStart);
    while (cursor < changes.length && changes[cursor].changedAt < dayEnd) {
      inForce = changes[cursor];
      cursor += 1;
    }
    return {
      date: formatUtcDay(dayStart),
      state: inForce ? ("recorded" as const) : ("not_recorded" as const),
      dailyBudgetCents: inForce ? inForce.dailyBudgetCents : null,
      inForceSince: inForce ? inForce.changedAt.toISOString() : null,
    };
  });

  return {
    recordBeginsAt: earliest ? earliest.changedAt.toISOString() : null,
    days,
  };
}
