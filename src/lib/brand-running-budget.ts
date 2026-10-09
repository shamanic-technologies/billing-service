/**
 * Which ceilings a budget write moved, as (before, after) pairs per mission.
 *
 * The staff budget-change email reports one line per changed mission; this is
 * the diff it reads. The previous per-ceiling values come from the write itself
 * (the locked pre-write read), never from another service. An opened ceiling
 * reads as 0 -> value, a deleted one as value -> 0.
 */

import { Decimal } from "decimal.js";
import { canonicalLegKey } from "./leg-identity.js";

/**
 * One ceiling this write touched. `previousDailyBudgetCents` is "0" for a
 * ceiling this write opened, `newDailyBudgetCents` is "0" for one it deleted.
 *
 * The brand-GRAIN scalar (PATCH /v1/brands/:brandId/daily-budget) is expressed
 * as a single change with every grain field null — which is exactly how
 * campaign-service names that ceiling when a brand is funded at the brand grain.
 */
export interface CeilingChange {
  featureSlug: string | null;
  offerId: string | null;
  legKey: string | null;
  previousDailyBudgetCents: string;
  newDailyBudgetCents: string;
}

/** A stored ceiling, in the only shape this module needs to diff two sets. */
export interface StoredCeiling {
  featureSlug: string;
  offerId: string | null;
  /** The leg this ceiling funds, or null for one written before legs existed. */
  legKey: string | null;
  dailyBudgetCents: string;
}

/**
 * Diff the ceilings a campaign write replaced against the ones it left.
 *
 * Only rows whose value MOVED are returned: a ceiling that kept its value
 * contributes nothing to either side of the running arithmetic, and it is not a
 * change to report either. An opened ceiling reads as 0 → value, a deleted one
 * as value → 0.
 */
export function ceilingChangesBetween(
  previous: StoredCeiling[],
  current: StoredCeiling[]
): CeilingChange[] {
  const key = (row: StoredCeiling) =>
    grainKey(row.featureSlug, row.offerId, row.legKey);
  const before = new Map(previous.map((row) => [key(row), row]));
  const after = new Map(current.map((row) => [key(row), row]));

  const changes: CeilingChange[] = [];
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const prev = before.get(k);
    const next = after.get(k);
    const previousDailyBudgetCents = prev ? prev.dailyBudgetCents : "0";
    const newDailyBudgetCents = next ? next.dailyBudgetCents : "0";
    if (
      new Decimal(previousDailyBudgetCents).equals(
        new Decimal(newDailyBudgetCents)
      )
    ) {
      continue;
    }
    const named = next ?? prev!;
    changes.push({
      featureSlug: named.featureSlug,
      offerId: named.offerId,
      legKey: named.legKey,
      previousDailyBudgetCents,
      newDailyBudgetCents,
    });
  }
  return changes;
}

/**
 * The single change a BRAND-GRAIN write makes. Every grain field is null, which
 * is exactly how campaign-service names a brand-grain ceiling.
 */
export function brandGrainChange(
  previousDailyBudgetCents: string | null,
  newDailyBudgetCents: string
): CeilingChange[] {
  const previous = previousDailyBudgetCents ?? "0";
  if (new Decimal(previous).equals(new Decimal(newDailyBudgetCents))) return [];
  return [
    {
      featureSlug: null,
      offerId: null,
      legKey: null,
      previousDailyBudgetCents: previous,
      newDailyBudgetCents,
    },
  ];
}

function grainKey(
  featureSlug: string | null,
  offerId: string | null,
  legKey: string | null
): string {
  const leg = legKey === null ? "" : canonicalLegKey(featureSlug, legKey);
  return [featureSlug ?? "", (offerId ?? "").toLowerCase(), leg].join(
    "\u0000"
  );
}
