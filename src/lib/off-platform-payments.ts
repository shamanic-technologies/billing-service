import { eq, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  ADMIN_GRANT_CODE,
  localPromoCodes,
  localPromos,
  offPlatformPayments,
} from "../db/schema.js";

/**
 * Off-platform payments (migration 0082, owner 2026-10-11: « revenue is cash the
 * client paid; a granted or advanced credit being consumed is never revenue »).
 *
 * A client who pays the owner directly (bank transfer) is credited by a staff
 * `admin_grant`. One `off_platform_payments` row marks that grant as money the client
 * PAID on `paid_at`, so billing states it as CASH: `cash_paid_cents` (GET /v1/accounts
 * and GET /internal/accounts/by-org/:orgId/cash), `credited_paid_cents` (out of
 * `credited_gifted_cents`), and `cash_by_month` at the payment month.
 *
 * The credit itself is the local_promos row, untouched: credited / balance never move,
 * so there is no double credit. Deliberately NOT read anywhere else: the reload tier,
 * the welcome trigger and entitlement, referral bars and advance repayment keep
 * reading Stripe-recorded payments, byte-unchanged (owner no-go 2026-10-11: no change
 * to how gifts, welcome, trial or advances are counted).
 */

/** Sum of the org's off-platform payments (the amounts of the grants they mark). */
export async function sumOffPlatformPaymentsForOrg(orgId: string): Promise<string> {
  const [row] = await db
    .select({
      total: rawSql<string>`COALESCE(SUM(${localPromos.amountCents}), 0)::numeric(16,10)::text`,
    })
    .from(offPlatformPayments)
    .innerJoin(localPromos, eq(offPlatformPayments.localPromoId, localPromos.id))
    .where(eq(offPlatformPayments.orgId, orgId));
  return row?.total ?? "0.0000000000";
}

export interface OffPlatformPaymentAmount {
  paidAt: Date;
  amountCents: string;
}

/** Every off-platform payment of the org, with its payment date (for cash_by_month). */
export async function listOffPlatformPaymentsForOrg(
  orgId: string
): Promise<OffPlatformPaymentAmount[]> {
  return db
    .select({ paidAt: offPlatformPayments.paidAt, amountCents: localPromos.amountCents })
    .from(offPlatformPayments)
    .innerJoin(localPromos, eq(offPlatformPayments.localPromoId, localPromos.id))
    .where(eq(offPlatformPayments.orgId, orgId));
}

export class GrantNotFoundError extends Error {
  constructor(grantId: string) {
    super(`grant not found: ${grantId}`);
  }
}

/** Only a staff admin_grant can be a client's payment; any other reason is refused. */
export class GrantNotReclassifiableError extends Error {
  constructor(grantId: string, reason: string) {
    super(`grant ${grantId} has reason ${reason}; only an ${ADMIN_GRANT_CODE} can be an off-platform payment`);
  }
}

/** The grant is already marked as paid on a DIFFERENT date. */
export class OffPlatformPaymentConflictError extends Error {
  constructor(grantId: string, existingPaidAt: Date) {
    super(`grant ${grantId} is already an off-platform payment dated ${existingPaidAt.toISOString()}`);
  }
}

export interface ReclassifyResult {
  grantId: string;
  orgId: string;
  amountCents: string;
  paidAt: string;
  recordedBy: string | null;
  note: string | null;
  recordedAt: string;
  alreadyRecorded: boolean;
}

/**
 * Mark an EXISTING admin_grant as an off-platform payment the client made on `paidAt`
 * (a grant staff created as a gift before the payment flag existed, e.g. Olive's $200).
 * Appends one off_platform_payments row; the grant row is never edited, so the
 * history stays readable: the grant's own created_at, the marking's created_at,
 * recorded_by and note. Balance unchanged.
 *
 * Idempotent: the same grant marked again with the same date → alreadyRecorded; a
 * different date → OffPlatformPaymentConflictError (409), never a silent re-date.
 */
export async function reclassifyGrantAsOffPlatformPayment(params: {
  grantId: string;
  paidAt: Date;
  recordedBy: string | null;
  note: string | null;
}): Promise<ReclassifyResult> {
  const { grantId, paidAt, recordedBy, note } = params;
  return db.transaction(async (tx) => {
    const [grant] = await tx
      .select({
        id: localPromos.id,
        orgId: localPromos.orgId,
        amountCents: localPromos.amountCents,
        reason: localPromoCodes.code,
      })
      .from(localPromos)
      .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
      .where(eq(localPromos.id, grantId))
      .limit(1);
    if (!grant) throw new GrantNotFoundError(grantId);
    if (grant.reason !== ADMIN_GRANT_CODE) throw new GrantNotReclassifiableError(grantId, grant.reason);

    const inserted = await tx
      .insert(offPlatformPayments)
      .values({ localPromoId: grant.id, orgId: grant.orgId, paidAt, recordedBy, note })
      .onConflictDoNothing({ target: offPlatformPayments.localPromoId })
      .returning();
    const row =
      inserted[0] ??
      (
        await tx
          .select()
          .from(offPlatformPayments)
          .where(eq(offPlatformPayments.localPromoId, grant.id))
          .limit(1)
      )[0];
    if (!inserted[0] && row.paidAt.getTime() !== paidAt.getTime()) {
      throw new OffPlatformPaymentConflictError(grantId, row.paidAt);
    }
    return {
      grantId: grant.id,
      orgId: grant.orgId,
      amountCents: grant.amountCents,
      paidAt: row.paidAt.toISOString(),
      recordedBy: row.recordedBy,
      note: row.note,
      recordedAt: row.createdAt.toISOString(),
      alreadyRecorded: !inserted[0],
    };
  });
}

/**
 * Parse a payment date given by staff: `YYYY-MM-DD` (read as UTC midnight) or a full
 * ISO date-time. Null when unreadable or in the future (a payment already happened).
 */
export function parseOffPlatformPaidAt(value: string, now: Date = new Date()): Date | null {
  let d: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) d = new Date(`${value}T00:00:00Z`);
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) d = new Date(value);
  else return null;
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() > now.getTime()) return null;
  return d;
}

export interface FleetOffPlatformPayment {
  orgId: string;
  paidAt: Date;
  amountCents: string;
}

/**
 * Every off-platform payment of the fleet, oldest first: the input the PLATFORM cash
 * series (`GET /public/stats/billing`) adds on top of stripe-service's acquirer and
 * `direct_payments` figures, so one bank transfer counts once whichever store holds it.
 */
export async function listAllOffPlatformPayments(): Promise<FleetOffPlatformPayment[]> {
  return db
    .select({
      orgId: offPlatformPayments.orgId,
      paidAt: offPlatformPayments.paidAt,
      amountCents: localPromos.amountCents,
    })
    .from(offPlatformPayments)
    .innerJoin(localPromos, eq(offPlatformPayments.localPromoId, localPromos.id))
    .orderBy(offPlatformPayments.paidAt);
}
