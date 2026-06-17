import { and, eq, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  WELCOME_PROMO_CODE,
  INVITE_WELCOME_CODE,
  FIRST_LOAD_MATCH_CAP_CENTS,
  FIRST_LOAD_MATCH_CODE,
  PLATFORM_GRANT_REASONS,
  type PlatformGrantReason,
} from "../db/schema.js";
import { Decimal } from "decimal.js";

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

export interface PromoCodeView {
  code: string;
  amountCents: number;
}

/**
 * Read a promo code's current grant amount (admin/config surface).
 * The `local_promo_codes` row is the live source of truth read at redeem time,
 * so this reflects exactly what a new redemption would grant. Throws
 * PromoNotFoundError if the code does not exist.
 */
export async function getPromoCode(code: string): Promise<PromoCodeView> {
  const [row] = await db
    .select()
    .from(localPromoCodes)
    .where(eq(localPromoCodes.code, code))
    .limit(1);
  if (!row) throw new PromoNotFoundError(code);
  return { code: row.code, amountCents: row.amountCents };
}

/**
 * Set a promo code's grant amount (admin/config surface) — lets the welcome
 * gift (or any admin-managed code) be re-priced WITHOUT a migration or deploy.
 * Single-row UPDATE keyed on the unique code. Throws PromoNotFoundError if the
 * code does not exist (never creates a row). Applies to NEW redemptions only;
 * orgs that already redeemed keep their existing local_promos grant.
 */
export async function setPromoCodeAmount(
  code: string,
  amountCents: number
): Promise<PromoCodeView> {
  const [row] = await db
    .update(localPromoCodes)
    .set({ amountCents })
    .where(eq(localPromoCodes.code, code))
    .returning();
  if (!row) throw new PromoNotFoundError(code);
  return { code: row.code, amountCents: row.amountCents };
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

// System sentinel — internal grants have no human user. Matches the convention
// used in /internal/transfer-brand (see routes/internal.ts).
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

export class UnknownGrantReasonError extends Error {
  constructor(reason: string) {
    super(`unknown grant reason: ${reason}`);
  }
}

export class GrantPromoCodeMissingError extends Error {
  constructor(code: string) {
    super(`grant promo code seed missing: ${code} (run migration 0017)`);
  }
}

export class FirstLoadMatchPromoCodeMissingError extends Error {
  constructor() {
    super(`first-load match promo code seed missing: ${FIRST_LOAD_MATCH_CODE}`);
  }
}

export interface GrantResult {
  localPromoId: string;
  promoCodeId: string;
  alreadyGranted: boolean;
}

/**
 * Platform-issued credit grant. Used by `/internal/credits/grant` to add credits
 * without requiring a user-redeemable promo code.
 *
 * Idempotency: the UNIQUE (org_id, promo_code_id) index on local_promos makes
 * repeated calls with the same (orgId, reason) a no-op (no double-grant).
 *
 * `invite_welcome` semantics: replaces (not stacks with) the $2 welcome row.
 * The tx (a) inserts billing_accounts ON CONFLICT DO NOTHING so a concurrent
 * findOrCreateAccount won't fire its own welcome-redeem branch, then (b)
 * deletes any existing welcome row, then (c) inserts the invite_welcome row.
 *
 * `invite_reward` is purely additive — no override.
 *
 * Fails loud on unknown reasons (rejected upstream at the route).
 */
export async function grantCredit(
  orgId: string,
  amountCents: number,
  reason: PlatformGrantReason
): Promise<GrantResult> {
  if (!PLATFORM_GRANT_REASONS.includes(reason)) {
    throw new UnknownGrantReasonError(reason);
  }

  const codeRows = await db
    .select()
    .from(localPromoCodes)
    .where(
      reason === INVITE_WELCOME_CODE
        ? rawSql`${localPromoCodes.code} IN (${reason}, ${WELCOME_PROMO_CODE})`
        : eq(localPromoCodes.code, reason)
    );

  const grantCode = codeRows.find((r) => r.code === reason);
  if (!grantCode) throw new GrantPromoCodeMissingError(reason);

  const welcomeCode =
    reason === INVITE_WELCOME_CODE
      ? codeRows.find((r) => r.code === WELCOME_PROMO_CODE)
      : undefined;

  const description =
    reason === INVITE_WELCOME_CODE
      ? `Invite welcome: $${(amountCents / 100).toFixed(2)}`
      : `Invite reward: $${(amountCents / 100).toFixed(2)}`;

  return await db.transaction(async (tx) => {
    // Pre-create the billing_accounts row so a concurrent findOrCreateAccount
    // sees an existing row and skips its welcome-redeem side-effect path.
    await tx
      .insert(billingAccounts)
      .values({ orgId })
      .onConflictDoNothing();

    if (reason === INVITE_WELCOME_CODE && welcomeCode) {
      await tx
        .delete(localPromos)
        .where(
          and(
            eq(localPromos.orgId, orgId),
            eq(localPromos.promoCodeId, welcomeCode.id)
          )
        );
    }

    const inserted = await tx
      .insert(localPromos)
      .values({
        orgId,
        userId: SYSTEM_USER_ID,
        amountCents: String(amountCents),
        promoCodeId: grantCode.id,
        description,
      })
      .onConflictDoNothing({
        target: [localPromos.orgId, localPromos.promoCodeId],
      })
      .returning();

    if (inserted.length > 0) {
      return {
        localPromoId: inserted[0].id,
        promoCodeId: grantCode.id,
        alreadyGranted: false,
      };
    }

    // Already granted — fetch existing row for the returned id.
    const [existing] = await tx
      .select({ id: localPromos.id })
      .from(localPromos)
      .where(
        and(
          eq(localPromos.orgId, orgId),
          eq(localPromos.promoCodeId, grantCode.id)
        )
      )
      .limit(1);

    return {
      localPromoId: existing.id,
      promoCodeId: grantCode.id,
      alreadyGranted: true,
    };
  });
}

/** Re-export billing_accounts table for callers that need it alongside promo helpers. */
export { billingAccounts };

export interface FirstLoadMatchResult {
  applied: boolean;
  amountCents: string;
  localPromoId: string | null;
}

function formatIntegerCents(amountCents: number): string {
  return new Decimal(amountCents).toFixed(10);
}

/**
 * Grant the org's first-load match: dollar-for-dollar up to $25, exactly once.
 *
 * The unique `(org_id, promo_code_id)` index is the hard once-per-org guard. A
 * repeated paid load returns `applied:false` and a zero newly-granted amount.
 */
export async function grantFirstLoadMatch(
  orgId: string,
  userId: string,
  paidLoadAmountCents: number
): Promise<FirstLoadMatchResult> {
  const matchAmountCents = Math.min(paidLoadAmountCents, FIRST_LOAD_MATCH_CAP_CENTS);

  const [promo] = await db
    .select()
    .from(localPromoCodes)
    .where(eq(localPromoCodes.code, FIRST_LOAD_MATCH_CODE))
    .limit(1);

  if (!promo) throw new FirstLoadMatchPromoCodeMissingError();

  const inserted = await db
    .insert(localPromos)
    .values({
      orgId,
      userId,
      amountCents: formatIntegerCents(matchAmountCents),
      promoCodeId: promo.id,
      description: `First-load match: $${(matchAmountCents / 100).toFixed(2)}`,
    })
    .onConflictDoNothing({
      target: [localPromos.orgId, localPromos.promoCodeId],
    })
    .returning();

  if (inserted.length > 0) {
    return {
      applied: true,
      amountCents: formatIntegerCents(matchAmountCents),
      localPromoId: inserted[0].id,
    };
  }

  const [existing] = await db
    .select({ id: localPromos.id })
    .from(localPromos)
    .where(and(eq(localPromos.orgId, orgId), eq(localPromos.promoCodeId, promo.id)))
    .limit(1);

  return {
    applied: false,
    amountCents: formatIntegerCents(0),
    localPromoId: existing?.id ?? null,
  };
}
