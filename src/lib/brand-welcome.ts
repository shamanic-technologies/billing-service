/**
 * Per-brand $25 welcome gift — 4-key un-farmable grant.
 *
 * Granted once when a brand's daily subscription gets a confirmed card. Deduped
 * across FOUR independent keys — org_id, user_id, brand_id, card_fingerprint — so
 * a prior claim on ANY of them yields $0. Each key carries its own UNIQUE index
 * on welcome_credit_claims, so the grant is a plain INSERT the DB rejects (23505)
 * when any key was already claimed: race-safe, no SELECT-then-insert window.
 * card_fingerprint is the un-spoofable key (same physical card can't re-claim
 * under a fresh org/user/brand).
 *
 * The money is a `local_promos` row under the `brand_welcome` code (so it composes
 * into balance like any promo); the claim row back-references it via local_promo_id.
 *
 * Fail-loud: a missing seed code, or any DB error other than the dedup 23505,
 * propagates.
 */

import { or, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  localPromoCodes,
  localPromos,
  welcomeCreditClaims,
  BRAND_WELCOME_CODE,
} from "../db/schema.js";

export class BrandWelcomeCodeMissingError extends Error {
  constructor() {
    super(
      `brand welcome promo code seed missing: ${BRAND_WELCOME_CODE} (run migration 0023)`
    );
  }
}

export interface BrandWelcomeParams {
  orgId: string;
  userId: string;
  brandId: string;
  cardFingerprint: string;
}

export interface BrandWelcomeResult {
  granted: boolean;
  /** Granted amount as a numeric(16,10) string; "0.0000000000" when suppressed. */
  amountCents: string;
  localPromoId: string | null;
}

const ZERO = "0.0000000000";

/**
 * Grant the per-brand $25 welcome gift IFF none of the four keys was ever claimed.
 * Returns { granted:false, amountCents:"0..." } when any key already claimed.
 */
export async function grantBrandWelcomeIfEligible(
  params: BrandWelcomeParams
): Promise<BrandWelcomeResult> {
  const { orgId, userId, brandId, cardFingerprint } = params;

  const [code] = await db
    .select()
    .from(localPromoCodes)
    .where(eq(localPromoCodes.code, BRAND_WELCOME_CODE))
    .limit(1);
  if (!code) throw new BrandWelcomeCodeMissingError();

  // Fast-path dedup: any of the four keys already claimed → suppress.
  const [existing] = await db
    .select({ id: welcomeCreditClaims.id })
    .from(welcomeCreditClaims)
    .where(
      or(
        eq(welcomeCreditClaims.orgId, orgId),
        eq(welcomeCreditClaims.userId, userId),
        eq(welcomeCreditClaims.brandId, brandId),
        eq(welcomeCreditClaims.cardFingerprint, cardFingerprint)
      )
    )
    .limit(1);
  if (existing) return { granted: false, amountCents: ZERO, localPromoId: null };

  const amountCents = String(code.amountCents);

  try {
    return await db.transaction(async (tx) => {
      // The four unique indexes are the race backstop: a concurrent claim that
      // slipped past the fast-path SELECT aborts this INSERT with 23505.
      const [claim] = await tx
        .insert(welcomeCreditClaims)
        .values({ orgId, userId, brandId, cardFingerprint, amountCents })
        .returning();

      // The credit itself — composes into balance via sumLocalPromoCreditsForOrg.
      const [promo] = await tx
        .insert(localPromos)
        .values({
          orgId,
          userId,
          amountCents,
          promoCodeId: code.id,
          brandIds: [brandId],
          description: `Brand welcome gift: $${(code.amountCents / 100).toFixed(2)}`,
        })
        .returning();

      await tx
        .update(welcomeCreditClaims)
        .set({ localPromoId: promo.id })
        .where(eq(welcomeCreditClaims.id, claim.id));

      // promo.amountCents is the canonical numeric(16,10) string ("2500.0000000000").
      return { granted: true, amountCents: promo.amountCents, localPromoId: promo.id };
    });
  } catch (err) {
    // 23505 from either the 4-key claim or the (org,promo) local_promos index =
    // already claimed (lost the race) → suppress, do not double-grant.
    if ((err as { code?: string }).code === "23505") {
      return { granted: false, amountCents: ZERO, localPromoId: null };
    }
    throw err;
  }
}
