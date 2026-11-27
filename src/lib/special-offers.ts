/**
 * Special offers (migration 0104, SPECIAL-OFFER-BF-1127, owner 2026-11-27).
 *
 * A special offer is a NAMED, dated commercial offer the owner runs once (first:
 * "Black Friday 2026"), kept apart from the standing offers (welcome, referral
 * rewards, trial seed, staff admin_grant) so the client can later see on his billing
 * page what that offer brought him: the payments he made under it and the free credit
 * it gave him, both under the offer's name.
 *
 * Worked example (NOVEMIQ, the first case): the client pays a $450 top-up on Black
 * Friday; staff applies "Black Friday 2026" (ratio 100%) to that payment; +$450 free
 * credit lands, tied to the offer and to that payment. Applying it again is a no-op.
 *
 *   special_offers            the offer: slug, name, window, default bonus ratio.
 *   special_offer_payments    one PAYMENT counted under it + the free credit granted.
 *
 * Money: the free credit is ONE ordinary `local_promos` row under the `special_offer`
 * ledger key, so credited / balance / every gate count it exactly like any other
 * grant. The payment itself stays what it is in stripe-service: nothing here records
 * or moves a payment, the link only says which offer it counts under.
 *
 * NOT cumulative with the standing offers (owner: "That would not be cumulative with
 * other offers ... It would be a separated Black Friday offer"): the credit is left out
 * of the welcome entitlement sum and of a subscription trial's credit, and nothing
 * here reads or writes a free-credit promise. A staff decision, like admin_grant: it
 * does not go through `assertFreeCreditAllowed`.
 *
 * A payment counts under ONE special offer, ONCE: UNIQUE (payment_acquirer, payment_id),
 * and the credit row carries `idempotency_key = special_offer:<acquirer>:<payment id>`.
 * Sends nothing to anyone.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import {
  localPromoCodes,
  localPromos,
  PLATFORM_USER_ID,
  SPECIAL_OFFER_CODE,
  specialOfferPayments,
  specialOffers,
  type SpecialOffer,
  type SpecialOfferPayment,
} from "../db/schema.js";
import { GrantPromoCodeMissingError } from "./promos.js";
import { listOrgPayments } from "./stripe-service-client.js";

/** The only currency a special offer's ratio is applied in (credit is USD cents). */
const OFFER_CURRENCY = "usd";

export class SpecialOfferNotFoundError extends Error {
  constructor(slug: string) {
    super(`special offer not found: ${slug}`);
  }
}

/** The slug already names an offer with different terms. */
export class SpecialOfferConflictError extends Error {
  constructor(slug: string) {
    super(`special offer ${slug} already exists with different terms`);
  }
}

export class SpecialOfferPaymentNotFoundError extends Error {
  constructor(orgId: string, paymentId: string) {
    super(`org ${orgId} has no payment ${paymentId}`);
  }
}

/** stripe-service could not be asked for the org's payments: nothing was applied. */
export class SpecialOfferPaymentsUnreadableError extends Error {
  constructor(orgId: string, cause: unknown) {
    super(`could not read the payments of org ${orgId}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export type SpecialOfferRefusalCode =
  | "payment_not_succeeded"
  | "payment_currency_unsupported"
  | "payment_fully_returned"
  | "payment_outside_offer_window"
  | "free_credit_zero"
  | "payment_under_other_offer"
  | "already_applied_different_amount";

/** The offer cannot be applied to this payment (409 + `code`). Nothing was written. */
export class SpecialOfferRefusedError extends Error {
  constructor(
    public readonly code: SpecialOfferRefusalCode,
    message: string
  ) {
    super(message);
  }
}

export interface SpecialOfferView {
  id: string;
  slug: string;
  name: string;
  startsAt: string;
  endsAt: string;
  bonusRatioBps: number;
  createdBy: string;
  createdAt: string;
}

function toOfferView(o: SpecialOffer): SpecialOfferView {
  return {
    id: o.id,
    slug: o.slug,
    name: o.name,
    startsAt: o.startsAt.toISOString(),
    endsAt: o.endsAt.toISOString(),
    bonusRatioBps: o.bonusRatioBps,
    createdBy: o.createdBy,
    createdAt: o.createdAt.toISOString(),
  };
}

export interface CreateSpecialOfferParams {
  slug: string;
  name: string;
  startsAt: Date;
  endsAt: Date;
  bonusRatioBps: number;
  createdBy: string;
}

/**
 * Create a special offer. Idempotent on the slug: the same terms again answer the
 * existing offer (`alreadyExisted`); different terms are refused, never overwritten
 * (payments may already count under it).
 */
export async function createSpecialOffer(
  params: CreateSpecialOfferParams
): Promise<{ offer: SpecialOfferView; alreadyExisted: boolean }> {
  const inserted = await db
    .insert(specialOffers)
    .values(params)
    .onConflictDoNothing({ target: specialOffers.slug })
    .returning();
  if (inserted.length > 0) return { offer: toOfferView(inserted[0]), alreadyExisted: false };

  const [existing] = await db
    .select()
    .from(specialOffers)
    .where(eq(specialOffers.slug, params.slug))
    .limit(1);
  const same =
    existing.name === params.name &&
    existing.startsAt.getTime() === params.startsAt.getTime() &&
    existing.endsAt.getTime() === params.endsAt.getTime() &&
    existing.bonusRatioBps === params.bonusRatioBps;
  if (!same) throw new SpecialOfferConflictError(params.slug);
  return { offer: toOfferView(existing), alreadyExisted: true };
}

export async function listSpecialOffers(): Promise<SpecialOfferView[]> {
  const rows = await db.select().from(specialOffers).orderBy(asc(specialOffers.startsAt));
  return rows.map(toOfferView);
}

export interface SpecialOfferPaymentView {
  id: string;
  orgId: string;
  paymentId: string;
  acquirer: string;
  /** What the client paid under the offer, decimal cents string. */
  paidCents: string;
  paidAt: string;
  /** The free credit this payment earned under the offer, decimal cents string. */
  freeCreditCents: string;
  grantId: string;
  appliedBy: string;
  note: string | null;
  appliedAt: string;
}

function cents(v: Decimal.Value): string {
  return new Decimal(v).toFixed(10);
}

function toPaymentView(p: SpecialOfferPayment): SpecialOfferPaymentView {
  return {
    id: p.id,
    orgId: p.orgId,
    paymentId: p.paymentId,
    acquirer: p.paymentAcquirer,
    paidCents: cents(p.paidCents),
    paidAt: p.paidAt.toISOString(),
    freeCreditCents: cents(p.freeCreditCents),
    grantId: p.localPromoId,
    appliedBy: p.appliedBy,
    note: p.note,
    appliedAt: p.createdAt.toISOString(),
  };
}

/** The offer's default credit for a payment: paid x ratio, rounded to a whole cent. */
export function specialOfferCreditCents(paidCents: number, bonusRatioBps: number): number {
  return new Decimal(paidCents).times(bonusRatioBps).div(10000).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

export function specialOfferIdempotencyKey(acquirer: string, paymentId: string): string {
  return `special_offer:${acquirer}:${paymentId}`;
}

export interface ApplySpecialOfferParams {
  slug: string;
  orgId: string;
  paymentId: string;
  appliedBy: string;
  /** Staff override of the credit; absent = the offer's ratio of what was paid. */
  freeCreditCents?: number;
  note?: string | null;
}

export interface ApplySpecialOfferResult {
  offer: SpecialOfferView;
  payment: SpecialOfferPaymentView;
  /** True when this payment already counted under this offer: nothing new was granted. */
  alreadyApplied: boolean;
}

/**
 * Count one of the org's payments under a special offer and grant the free credit it
 * earns. The payment is read from stripe-service (every acquirer) and must be the
 * org's own, succeeded, in USD, not fully returned, and dated inside the offer's
 * window. Idempotent per payment: applied again, it answers what was granted the
 * first time and writes nothing.
 */
export async function applySpecialOfferToPayment(
  params: ApplySpecialOfferParams
): Promise<ApplySpecialOfferResult> {
  const { slug, orgId, paymentId, appliedBy } = params;
  const [offer] = await db.select().from(specialOffers).where(eq(specialOffers.slug, slug)).limit(1);
  if (!offer) throw new SpecialOfferNotFoundError(slug);

  let payments;
  try {
    payments = await listOrgPayments(orgId);
  } catch (err) {
    throw new SpecialOfferPaymentsUnreadableError(orgId, err);
  }
  const payment = payments.find((p) => p.id === paymentId);
  if (!payment) throw new SpecialOfferPaymentNotFoundError(orgId, paymentId);
  if (payment.status !== "succeeded") {
    throw new SpecialOfferRefusedError("payment_not_succeeded", `payment ${paymentId} is ${payment.status}`);
  }
  if (payment.currency.toLowerCase() !== OFFER_CURRENCY) {
    throw new SpecialOfferRefusedError(
      "payment_currency_unsupported",
      `payment ${paymentId} is in ${payment.currency}; a special offer applies to ${OFFER_CURRENCY} payments`
    );
  }
  // Fail loud: a payment read that does not say what was returned must never be
  // rewarded as if nothing had been.
  if (typeof payment.amount !== "number" || typeof payment.amount_returned !== "number") {
    throw new SpecialOfferPaymentsUnreadableError(orgId, "the payment carries no amount / amount_returned");
  }
  const paidCents = payment.amount - payment.amount_returned;
  if (paidCents <= 0) {
    throw new SpecialOfferRefusedError("payment_fully_returned", `payment ${paymentId} was fully returned`);
  }
  const paidAt = new Date(payment.created * 1000);
  if (paidAt < offer.startsAt || paidAt >= offer.endsAt) {
    throw new SpecialOfferRefusedError(
      "payment_outside_offer_window",
      `payment ${paymentId} was made ${paidAt.toISOString()}, outside ${offer.name} (${offer.startsAt.toISOString()} to ${offer.endsAt.toISOString()})`
    );
  }
  const freeCreditCents = params.freeCreditCents ?? specialOfferCreditCents(paidCents, offer.bonusRatioBps);
  if (freeCreditCents <= 0) {
    throw new SpecialOfferRefusedError("free_credit_zero", `${offer.name} grants nothing on payment ${paymentId}`);
  }

  const [promoCode] = await db
    .select()
    .from(localPromoCodes)
    .where(eq(localPromoCodes.code, SPECIAL_OFFER_CODE))
    .limit(1);
  if (!promoCode) throw new GrantPromoCodeMissingError(SPECIAL_OFFER_CODE);

  const key = specialOfferIdempotencyKey(payment.acquirer, payment.id);
  return db.transaction(async (tx) => {
    // One apply per payment at a time: the second waits, then reads the first's row.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);

    const [existing] = await tx
      .select()
      .from(specialOfferPayments)
      .where(
        and(
          eq(specialOfferPayments.paymentAcquirer, payment.acquirer),
          eq(specialOfferPayments.paymentId, payment.id)
        )
      )
      .limit(1);
    if (existing) {
      if (existing.specialOfferId !== offer.id) {
        throw new SpecialOfferRefusedError(
          "payment_under_other_offer",
          `payment ${paymentId} already counts under another special offer`
        );
      }
      if (params.freeCreditCents !== undefined && !new Decimal(existing.freeCreditCents).eq(params.freeCreditCents)) {
        throw new SpecialOfferRefusedError(
          "already_applied_different_amount",
          `${offer.name} already granted ${existing.freeCreditCents} cents on payment ${paymentId}`
        );
      }
      return { offer: toOfferView(offer), payment: toPaymentView(existing), alreadyApplied: true };
    }

    const [grant] = await tx
      .insert(localPromos)
      .values({
        orgId,
        userId: PLATFORM_USER_ID,
        amountCents: String(freeCreditCents),
        promoCodeId: promoCode.id,
        description: `${offer.name}: $${(freeCreditCents / 100).toFixed(2)} free credit`,
        grantedBy: appliedBy,
        idempotencyKey: key,
      })
      .returning();
    const [link] = await tx
      .insert(specialOfferPayments)
      .values({
        specialOfferId: offer.id,
        orgId,
        paymentAcquirer: payment.acquirer,
        paymentId: payment.id,
        paidCents,
        paidAt,
        freeCreditCents: String(freeCreditCents),
        localPromoId: grant.id,
        appliedBy,
        note: params.note ?? null,
      })
      .returning();
    return { offer: toOfferView(offer), payment: toPaymentView(link), alreadyApplied: false };
  });
}

export interface OrgSpecialOffer {
  slug: string;
  name: string;
  startsAt: string;
  endsAt: string;
  /** Sum of the org's payments under this offer, decimal cents string. */
  paidCents: string;
  /** Sum of the free credit this offer gave the org, decimal cents string. */
  freeCreditCents: string;
  payments: SpecialOfferPaymentView[];
}

/**
 * What each special offer brought ONE org: its payments under the offer and the free
 * credit they earned, totals ready-made (the dashboard never sums money). Only offers
 * the org has a payment under; oldest offer first, payments oldest first.
 */
export async function listSpecialOffersForOrg(orgId: string): Promise<OrgSpecialOffer[]> {
  const rows = await db
    .select({ offer: specialOffers, payment: specialOfferPayments })
    .from(specialOfferPayments)
    .innerJoin(specialOffers, eq(specialOfferPayments.specialOfferId, specialOffers.id))
    .where(eq(specialOfferPayments.orgId, orgId))
    .orderBy(asc(specialOffers.startsAt), asc(specialOfferPayments.paidAt), asc(specialOfferPayments.id));
  const byOffer = new Map<string, OrgSpecialOffer & { paid: Decimal; free: Decimal }>();
  for (const { offer, payment } of rows) {
    let entry = byOffer.get(offer.id);
    if (!entry) {
      entry = {
        slug: offer.slug,
        name: offer.name,
        startsAt: offer.startsAt.toISOString(),
        endsAt: offer.endsAt.toISOString(),
        paidCents: "",
        freeCreditCents: "",
        payments: [],
        paid: new Decimal(0),
        free: new Decimal(0),
      };
      byOffer.set(offer.id, entry);
    }
    entry.paid = entry.paid.plus(payment.paidCents);
    entry.free = entry.free.plus(payment.freeCreditCents);
    entry.payments.push(toPaymentView(payment));
  }
  return [...byOffer.values()].map(({ paid, free, ...rest }) => ({
    ...rest,
    paidCents: cents(paid),
    freeCreditCents: cents(free),
  }));
}
