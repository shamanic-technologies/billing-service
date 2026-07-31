import { and, desc, eq, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  WELCOME_PROMO_CODE,
  INVITE_WELCOME_CODE,
  ADMIN_GRANT_CODE,
  REFERRAL_REWARD_CODE,
  PLATFORM_GRANT_REASONS,
  type PlatformGrantReason,
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

/**
 * Sum of the local promo credits that count against the org's WELCOME entitlement —
 * i.e. every grant EXCEPT a referral reward.
 *
 * The welcome-completion remainder is `entitlement − what the org was already
 * gifted`, which is what keeps it correct across cohorts and re-prices. Referral
 * rewards are additional money on top of the welcome offer, never a replacement for
 * it (a $500 referral must not swallow a $400 welcome remainder), so they are the one
 * grant kind excluded here. For an org that was never referred this is byte-identical
 * to `sumLocalPromoCreditsForOrg` — there are no referral rows to exclude.
 */
export async function sumEntitlementGrantsForOrg(orgId: string): Promise<string> {
  const [row] = await db
    .select({
      total: rawSql<string>`COALESCE(SUM(${localPromos.amountCents}), 0)::numeric(16,10)::text`,
    })
    .from(localPromos)
    .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
    .where(
      and(
        eq(localPromos.orgId, orgId),
        rawSql`${localPromoCodes.code} <> ${REFERRAL_REWARD_CODE}`
      )
    );
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
 * BOTH reasons are purely ADDITIVE. `invite_welcome` used to DELETE the org's `welcome`
 * row in the same tx so the two could not stack; that is retired. Nothing on an
 * invite / referral path may remove or reduce an existing promise or an
 * already-granted credit — invite and referral credits are additional money, never a
 * replacement. (The tx still pre-inserts billing_accounts ON CONFLICT DO NOTHING so a
 * concurrent findOrCreateAccount does not fire its own welcome-redeem branch.)
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

  const [grantCode] = await db
    .select()
    .from(localPromoCodes)
    .where(eq(localPromoCodes.code, reason))
    .limit(1);
  if (!grantCode) throw new GrantPromoCodeMissingError(reason);

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

    const inserted = await tx
      .insert(localPromos)
      .values({
        orgId,
        userId: SYSTEM_USER_ID,
        amountCents: String(amountCents),
        promoCodeId: grantCode.id,
        description,
      })
      // (org, promo_code) uniqueness is now PARTIAL (WHERE idempotency_key IS
      // NULL, migration 0025) — the conflict target must carry the predicate.
      .onConflictDoNothing({
        target: [localPromos.orgId, localPromos.promoCodeId],
        where: rawSql`idempotency_key IS NULL`,
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

// --- Admin-issued grants (staff oversight ledger) ---

export interface AdminGrantResult {
  localPromoId: string;
  alreadyGranted: boolean;
}

/**
 * Staff-issued arbitrary-amount credit grant. Backs `POST /v1/credits/grant`.
 *
 * Grants STACK: each call with a fresh `idempotencyKey` inserts a new
 * `local_promos` row under the `admin_grant` code (exempt from the (org,
 * promo_code) uniqueness because it carries an idempotency_key — migration
 * 0025). A retry with the SAME key is deduped by the partial unique index
 * `idx_local_promos_org_idempotency` → no double-grant.
 *
 * `note` is stored in `description`; `grantedBy` records the staff email.
 *
 * Fails loud (GrantPromoCodeMissingError) if the admin_grant seed is absent.
 */
export async function grantAdminCredit(
  orgId: string,
  amountCents: number,
  note: string | null,
  grantedBy: string | null,
  idempotencyKey: string
): Promise<AdminGrantResult> {
  const [code] = await db
    .select()
    .from(localPromoCodes)
    .where(eq(localPromoCodes.code, ADMIN_GRANT_CODE))
    .limit(1);
  if (!code) throw new GrantPromoCodeMissingError(ADMIN_GRANT_CODE);

  return await db.transaction(async (tx) => {
    // Pre-create the billing_accounts row so a concurrent findOrCreateAccount
    // sees an existing row and skips its welcome-redeem side-effect path.
    await tx.insert(billingAccounts).values({ orgId }).onConflictDoNothing();

    const inserted = await tx
      .insert(localPromos)
      .values({
        orgId,
        userId: SYSTEM_USER_ID,
        amountCents: String(amountCents),
        promoCodeId: code.id,
        description: note,
        grantedBy,
        idempotencyKey,
      })
      .onConflictDoNothing({
        target: [localPromos.orgId, localPromos.idempotencyKey],
        where: rawSql`idempotency_key IS NOT NULL`,
      })
      .returning();

    if (inserted.length > 0) {
      return { localPromoId: inserted[0].id, alreadyGranted: false };
    }

    // Same idempotency key already granted — fetch the existing row.
    const [existing] = await tx
      .select({ id: localPromos.id })
      .from(localPromos)
      .where(
        and(
          eq(localPromos.orgId, orgId),
          eq(localPromos.idempotencyKey, idempotencyKey)
        )
      )
      .limit(1);

    return { localPromoId: existing.id, alreadyGranted: true };
  });
}

export interface GrantListItem {
  id: string;
  orgId: string;
  amountCents: string;
  reason: string;
  note: string | null;
  grantedBy: string | null;
  createdAt: string;
}

const GRANT_LIST_COLUMNS = {
  id: localPromos.id,
  orgId: localPromos.orgId,
  amountCents: localPromos.amountCents,
  reason: localPromoCodes.code,
  note: localPromos.description,
  grantedBy: localPromos.grantedBy,
  createdAt: localPromos.createdAt,
} as const;

function toGrantItem(row: {
  id: string;
  orgId: string;
  amountCents: string;
  reason: string;
  note: string | null;
  grantedBy: string | null;
  createdAt: Date;
}): GrantListItem {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/**
 * List every credit grant (all local_promos rows) for one org — the per-org
 * oversight ledger. `reason` is the promo CODE (admin_grant, invite_*, welcome,
 * welcome_completion, or any redeemed promo). Newest first.
 */
export async function listGrantsForOrg(orgId: string): Promise<GrantListItem[]> {
  const rows = await db
    .select(GRANT_LIST_COLUMNS)
    .from(localPromos)
    .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
    .where(eq(localPromos.orgId, orgId))
    .orderBy(desc(localPromos.createdAt));
  return rows.map(toGrantItem);
}

/**
 * List every credit grant across ALL orgs — the platform-wide oversight ledger.
 * Newest first.
 */
export async function listAllGrants(): Promise<GrantListItem[]> {
  const rows = await db
    .select(GRANT_LIST_COLUMNS)
    .from(localPromos)
    .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
    .orderBy(desc(localPromos.createdAt));
  return rows.map(toGrantItem);
}
