/**
 * Per-org platform-usage discount.
 *
 * A discounted org effectively pays (1 − pct/100) of its GROSS platform usage.
 * The discount is applied ON READ wherever billing composes an org's spendable
 * balance — it REDUCES the usage component billing subtracts, so the balance
 * depletes proportionally slower and Stripe topups fire proportionally less
 * often. The GROSS usage in runs-service is never touched (reporting sees the
 * full number).
 *
 * ONE value per org (org_usage_discounts.org_id PK). Absence of a row = null =
 * no discount = today's exact behavior. Replaceable (upsert), removable (delete
 * → null, not retroactive — restores full pricing on the next composition).
 *
 * Fail-loud: an out-of-range percentage throws (the route also validates via
 * Zod); no silent clamp, no fallback default.
 */

import { Decimal } from "decimal.js";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgUsageDiscounts } from "../db/schema.js";

// Match the fractional-cents scale used everywhere (numeric(16,10)).
const SCALE = 10;

export class InvalidUsageDiscountError extends Error {
  constructor(value: unknown) {
    super(
      `usage discount percentage must be an integer 0–100, got ${String(value)}`
    );
    this.name = "InvalidUsageDiscountError";
  }
}

export interface UsageDiscount {
  discountPct: number;
  /** Staff email behind the discount; null when none was recorded. */
  setBy: string | null;
  /** ISO-8601 timestamp the discount was last set. */
  setAt: string;
}

/**
 * The org's usage-discount percentage, or null when unset (no discount).
 * The single value read on every balance-composition path.
 */
export async function getUsageDiscountPct(orgId: string): Promise<number | null> {
  const [row] = await db
    .select({ discountPct: orgUsageDiscounts.discountPct })
    .from(orgUsageDiscounts)
    .where(eq(orgUsageDiscounts.orgId, orgId))
    .limit(1);
  return row ? row.discountPct : null;
}

/** The full discount row (pct + audit), or null when unset. */
export async function getUsageDiscount(orgId: string): Promise<UsageDiscount | null> {
  const [row] = await db
    .select()
    .from(orgUsageDiscounts)
    .where(eq(orgUsageDiscounts.orgId, orgId))
    .limit(1);
  if (!row) return null;
  return {
    discountPct: row.discountPct,
    setBy: row.setBy,
    setAt: row.setAt.toISOString(),
  };
}

/**
 * Set / replace an org's usage discount. Upsert on org_id — ONE value per org.
 * Fail-loud on an out-of-range percentage (never clamps).
 */
export async function setUsageDiscount(
  orgId: string,
  discountPct: number,
  setBy: string | null
): Promise<UsageDiscount> {
  if (!Number.isInteger(discountPct) || discountPct < 0 || discountPct > 100) {
    throw new InvalidUsageDiscountError(discountPct);
  }
  const now = new Date();
  const [row] = await db
    .insert(orgUsageDiscounts)
    .values({ orgId, discountPct, setBy, setAt: now })
    .onConflictDoUpdate({
      target: orgUsageDiscounts.orgId,
      set: { discountPct, setBy, setAt: now },
    })
    .returning();
  return {
    discountPct: row.discountPct,
    setBy: row.setBy,
    setAt: row.setAt.toISOString(),
  };
}

/**
 * Remove an org's usage discount (→ null, restoring full pricing on the next
 * composition — not retroactive). Idempotent: returns true iff a row existed.
 */
export async function removeUsageDiscount(orgId: string): Promise<boolean> {
  const removed = await db
    .delete(orgUsageDiscounts)
    .where(eq(orgUsageDiscounts.orgId, orgId))
    .returning({ orgId: orgUsageDiscounts.orgId });
  return removed.length > 0;
}

/**
 * Net usage after applying the org's discount: gross × (1 − pct/100).
 *
 * pct null or 0 → returns the gross string UNCHANGED (byte-identical to
 * pre-discount behavior — the whole point of backward compatibility). Otherwise
 * returns a canonical fixed-scale string.
 */
export function applyUsageDiscount(
  grossUsageCents: string,
  discountPct: number | null
): string {
  if (discountPct == null || discountPct === 0) return grossUsageCents;
  const factor = new Decimal(100 - discountPct).dividedBy(100);
  return new Decimal(grossUsageCents).times(factor).toFixed(SCALE);
}
