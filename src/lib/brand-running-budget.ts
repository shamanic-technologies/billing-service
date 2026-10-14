/**
 * What a brand-grain budget write moved, as a (before, after) pair. The staff
 * budget-change email reports it as one mission line. (The per-campaign ceiling
 * diff that lived here was retired with the ceilings, 2026-10-14.)
 */

import { Decimal } from "decimal.js";

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
