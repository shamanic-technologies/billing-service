import { and, eq, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  WELCOME_PROMO_CODE,
} from "../db/schema.js";

export class PromoNotFoundError extends Error {
  constructor(code: string) {
    super(`promo code not found: ${code}`);
  }
}
export class PromoExpiredError extends Error {
  constructor(code: string) {
    super(`promo code expired: ${code}`);
  }
}
export class PromoExhaustedError extends Error {
  constructor(code: string) {
    super(`promo code redemption limit reached: ${code}`);
  }
}
export class PromoAlreadyRedeemedError extends Error {
  constructor(code: string) {
    super(`promo code already redeemed by this org: ${code}`);
  }
}

export interface RedeemResult {
  promoCodeId: string;
  amountCents: number;
  localPromoId: string;
}

/**
 * Redeem a promo code for an org. Inserts one `local_promos` row (UNIQUE on
 * (org_id, promo_code_id)). Welcome gift = redeem `code='welcome'`.
 *
 * Throws specific errors so callers can map to HTTP codes.
 */
export async function redeemPromoCode(
  orgId: string,
  userId: string,
  code: string
): Promise<RedeemResult> {
  const [promo] = await db
    .select()
    .from(localPromoCodes)
    .where(eq(localPromoCodes.code, code))
    .limit(1);

  if (!promo) throw new PromoNotFoundError(code);
  if (promo.expiresAt && promo.expiresAt < new Date()) {
    throw new PromoExpiredError(code);
  }

  if (promo.maxRedemptions !== null) {
    const [countRow] = await db
      .select({ count: rawSql<number>`count(*)::int` })
      .from(localPromos)
      .where(eq(localPromos.promoCodeId, promo.id));
    if (countRow.count >= promo.maxRedemptions) {
      throw new PromoExhaustedError(code);
    }
  }

  try {
    const [inserted] = await db
      .insert(localPromos)
      .values({
        orgId,
        userId,
        amountCents: String(promo.amountCents),
        promoCodeId: promo.id,
        description: code === WELCOME_PROMO_CODE
          ? `Trial gift: $${(promo.amountCents / 100).toFixed(2)}`
          : `Promo: ${code} ($${(promo.amountCents / 100).toFixed(2)})`,
      })
      .returning();
    return {
      promoCodeId: promo.id,
      amountCents: promo.amountCents,
      localPromoId: inserted.id,
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes("idx_local_promos_org_promo")) {
      throw new PromoAlreadyRedeemedError(code);
    }
    throw err;
  }
}

/** Sum of all local promo credits ever granted to this org. */
export async function sumLocalPromoCreditsForOrg(orgId: string): Promise<string> {
  const [row] = await db
    .select({
      total: rawSql<string>`COALESCE(SUM(${localPromos.amountCents}), 0)::numeric(16,10)::text`,
    })
    .from(localPromos)
    .where(eq(localPromos.orgId, orgId));
  return row?.total ?? "0.0000000000";
}

/** Find welcome promo code row (seeded by migration 0016). Throws if missing. */
export async function getWelcomePromoCode() {
  const [row] = await db
    .select()
    .from(localPromoCodes)
    .where(eq(localPromoCodes.code, WELCOME_PROMO_CODE))
    .limit(1);
  if (!row) {
    throw new Error("welcome promo code missing — migration 0016 not applied");
  }
  return row;
}

/** True if this org has already redeemed the given promo code. */
export async function hasRedeemed(orgId: string, promoCodeId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: localPromos.id })
    .from(localPromos)
    .where(and(eq(localPromos.orgId, orgId), eq(localPromos.promoCodeId, promoCodeId)))
    .limit(1);
  return !!row;
}

/** Re-export billing_accounts table for callers that need it alongside promo helpers. */
export { billingAccounts };
