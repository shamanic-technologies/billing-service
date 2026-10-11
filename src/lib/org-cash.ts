import { eq } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import { composeCreditedCents } from "./balance.js";
import { listOrgPayments, sumPaidTopupsForOrgAsOf } from "./stripe-service-client.js";
import {
  listOffPlatformPaymentsForOrg,
  sumOffPlatformPaymentsForOrg,
  type OffPlatformPaymentAmount,
} from "./off-platform-payments.js";

/**
 * Cash vs credit for ONE org, for staff revenue reads (features-service): owner rule
 * 2026-10-11, « revenue is cash the client paid; a granted or advanced credit being
 * consumed is never revenue ».
 *
 * - `cashPaidCents`: the SAME figure as `cash_paid_cents` on GET /v1/accounts (every
 *   succeeded payment, every acquirer, NET of refunds + lost disputes, never reduced by
 *   what it repaid) PLUS the payments the client made OFF-platform (a staff grant
 *   marked as one, lib/off-platform-payments).
 * - `stripePaidCents`: the acquirer half alone (what `cash_by_month` replays per month).
 * - `creditedCents`: the ONE credited composition (`composeCreditedCents`).
 * - `nonCashCreditCents` = credited − cash: what the org received that it did not pay
 *   for (gifts, an advance not yet repaid). An advance its payments repaid is cash, so
 *   it is not in here. Pure read: no settle, no grant, no Stripe customer created.
 */
export interface OrgCash {
  orgId: string;
  cashPaidCents: string;
  stripePaidCents: string;
  creditedCents: string;
  nonCashCreditCents: string;
}

export async function getOrgCash(orgId: string): Promise<OrgCash> {
  const [{ paidTopupsCents, creditedCents }, offPlatformCents] = await Promise.all([
    composeCreditedCents(orgId),
    sumOffPlatformPaymentsForOrg(orgId),
  ]);
  const cashPaidCents = new Decimal(paidTopupsCents).plus(offPlatformCents).toFixed(10);
  return {
    orgId,
    cashPaidCents,
    stripePaidCents: paidTopupsCents,
    creditedCents,
    nonCashCreditCents: new Decimal(creditedCents).minus(cashPaidCents).toFixed(10),
  };
}

export interface CashMonth {
  /** UTC calendar month, `YYYY-MM`. */
  month: string;
  /** Cash collected that month, NET: payments minus refunds / lost disputes that HAPPENED that month. */
  cashPaidCents: string;
}

function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function nextMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/**
 * Net cash collected per UTC month, from the org's first activity month to the
 * current one. Each month = paid-net as of its end − paid-net as of its start, both
 * asked of stripe-service (`payment_summary?as_of=`, bounding payments AND returns),
 * so a refund lands in the month it happened and the months add up to `totalCents`
 * by construction (the current month closes on the all-time figure). An off-platform
 * payment lands in the UTC month of its `paid_at`.
 *
 * Fail-loud: if stripe-service reports cash before the first month we start from,
 * a payment exists that neither the payments list nor the account shows, and the
 * series would silently miss it → throw.
 */
export async function getOrgCashByMonth(
  orgId: string,
  /** The ACQUIRER total (`OrgCash.stripePaidCents`), off-platform payments excluded. */
  totalCents: string,
  now: Date = new Date()
): Promise<CashMonth[]> {
  const [payments, offPlatform, [account]] = await Promise.all([
    listOrgPayments(orgId),
    listOffPlatformPaymentsForOrg(orgId),
    db
      .select({ createdAt: billingAccounts.createdAt })
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1),
  ]);
  const starts: number[] = payments.filter((p) => p.status === "succeeded").map((p) => p.created * 1000);
  if (account) starts.push(account.createdAt.getTime());
  for (const p of offPlatform) starts.push(p.paidAt.getTime());
  if (starts.length === 0) {
    if (!new Decimal(totalCents).isZero()) {
      throw new Error(`org ${orgId} has cash ${totalCents} but no payment or account to date it`);
    }
    return [];
  }
  const first = monthStartUtc(new Date(Math.min(...starts)));
  const current = monthStartUtc(now);
  const boundaries: Date[] = [];
  for (let m = first; m.getTime() <= current.getTime(); m = nextMonth(m)) boundaries.push(m);

  const netAt = await Promise.all(
    boundaries.map((b) => sumPaidTopupsForOrgAsOf(orgId, Math.floor(b.getTime() / 1000)))
  );
  if (!new Decimal(netAt[0]).isZero()) {
    throw new Error(
      `org ${orgId} had cash ${netAt[0]} before ${boundaries[0].toISOString()}, earlier than any payment or account`
    );
  }
  const closes = [...netAt.slice(1), totalCents];
  return boundaries.map((b, i) => {
    const month = b.toISOString().slice(0, 7);
    return {
      month,
      cashPaidCents: new Decimal(closes[i])
        .minus(netAt[i])
        .plus(offPlatformInMonth(offPlatform, month))
        .toFixed(10),
    };
  });
}

function offPlatformInMonth(payments: OffPlatformPaymentAmount[], month: string): Decimal {
  return payments
    .filter((p) => p.paidAt.toISOString().slice(0, 7) === month)
    .reduce((sum, p) => sum.plus(p.amountCents), new Decimal(0));
}
